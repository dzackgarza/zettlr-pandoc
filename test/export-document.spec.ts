/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the export of one document
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An export of a document with unsaved text exports that
 *                  text as the document that it is: in the folder of the
 *                  document, with its figures and its wikilinks. An export
 *                  that cannot use a folder or a citation file that the
 *                  author named is refused with the name. These tests run
 *                  the real export over the real documents provider and the
 *                  real FSAL, with the real pandoc and a recipe runner that
 *                  is a real process.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import AssetsProvider, { type ValidPandocProfile } from "source/app/service-providers/assets";
import {
  type DocumentExportServices,
  exportDocument,
} from "source/app/service-providers/commands/export";
import ConfigProvider from "source/app/service-providers/config";
import type DocumentManager from "source/app/service-providers/documents";
import type FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import LongRunningTaskProvider from "source/app/service-providers/long-running-tasks";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { bootDocumentManager } from "./documents-provider-seam";
import { bootFsal } from "./fsal-seam";
import { userData } from "./headless-electron-harness.cjs";
import { installRecordingJust, type RecordingJust } from "./recording-just";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

/** A document with the LaTeX delimiters of math, which the editor reads as math. */
const BRACKET_MATH = "# Forms\n\nThe form \\(q(x) = x^2\\) has\n\n\\[\n\\Delta = 4\n\\]\n";

const DOCUMENT = [
  "# Lattices",
  "",
  "A lattice is a free abelian group with a bilinear form.",
  "",
  "![The Gram matrix](figures/gram.png)",
  "",
  "## Genus",
  "",
  "Two forms of one genus. See [[Lattices#Genus]].",
  "",
].join("\n");

/** The text that the author typed and did not save. */
const UNSAVED = "An unsaved sentence about unimodular lattices.\n\n";

/** A document that declares a working directory. */
function declaring(workingDirectory: string): string {
  return `---\nzettlr:\n  pandoc_working_dir: ${workingDirectory}\n---\n\n# Declared\n\nA form.\n`;
}

/** The recipe file that a PDF export runs. */
const RECIPE_FILE = path.join(homedir(), ".pandoc", "justfile");

const PDF: ValidPandocProfile = {
  name: "PDF.yaml",
  reader: "markdown",
  writer: "compile-pandoc",
  isInvalid: false,
};
const TEXTBUNDLE: ValidPandocProfile = {
  name: "Textbundle.yaml",
  reader: "markdown",
  writer: "textbundle",
  isInvalid: false,
};
const LATEX: ValidPandocProfile = {
  name: "LaTeX.yaml",
  reader: "markdown",
  writer: "latex",
  isInvalid: false,
};
const WORD: ValidPandocProfile = {
  name: "Microsoft Word.yaml",
  reader: "markdown",
  writer: "docx",
  isInvalid: false,
};
const WORKING_DIRECTORY: ValidPandocProfile = {
  name: "Working directory",
  reader: "markdown",
  writer: "script",
  isInvalid: false,
};

/** An error window that the export opened. */
interface ErrorWindow {
  title: string;
  message: string;
  contents: string | undefined;
}

describe("Export of one document", function () {
  let root: string;
  let scripts: string;
  let macroHome: string;
  let document: string;
  let just: RecordingJust;
  let fsal: FSAL;
  let documents: DocumentManager;
  let assets: AssetsProvider;
  let config: ConfigProvider;
  let services: DocumentExportServices;
  const errorWindows: ErrorWindow[] = [];

  /** The author types at the start of a document and does not save. */
  async function typeUnsaved(documentPath: string): Promise<void> {
    const windowId = documents.windowKeys()[0];
    const leafId = documents.leafIds(windowId)[0];
    await documents.getDocument(documentPath);
    assert.equal(await documents.openFile(windowId, leafId, documentPath), true);
    await documents.applyWorkspaceTextEdits([
      { documentPath, range: { from: 0, to: 0 }, insert: UNSAVED },
    ]);
    assert.equal(documents.isModified(documentPath), true);
  }

  /** The text of each error window, in one string. */
  function shownText(): string {
    return errorWindows.map((shown) => `${shown.message}\n${shown.contents}`).join("\n");
  }

  before(async function () {
    just = await installRecordingJust();
    scripts = await mkdtemp(path.join(tmpdir(), "zettlr-export-document-commands-"));

    // An export reads the macro projection of the home directory.
    macroHome = path.join(tmpdir(), ".pandoc");
    const projection = path.join(macroHome, "templates", "css");
    await mkdir(projection, { recursive: true });
    await copyFile(
      path.resolve("test", "fixtures", "mathjax-macros.json"),
      path.join(projection, "mathjax-macros.json"),
    );

    // The export profiles of the author.
    const defaults = path.join(userData, "defaults");
    await mkdir(defaults, { recursive: true });
    await copyFile(
      path.resolve("static", "defaults", "LaTeX.yaml"),
      path.join(defaults, "LaTeX.yaml"),
    );
    await copyFile(
      path.resolve("static", "defaults", "Microsoft Word.yaml"),
      path.join(defaults, "Microsoft Word.yaml"),
    );

    // An export script that writes its working directory to its output.
    const script = path.join(scripts, "working-directory.sh");
    await writeFile(script, '#!/bin/sh\npwd > "$2"\n');
    await chmod(script, 0o755);

    const log = new LogProvider();
    config = new ConfigProvider(log, [path.resolve("static", "lang")], unexpectedStoreWriteFailure);
    // The open of an exported file is proved in the assembled app.
    config.set("export.autoOpenExportedFiles", false);
    config.set("export.scripts", [
      { name: WORKING_DIRECTORY.name, profile: LATEX.name, command: script, extension: "txt" },
    ]);
    assets = new AssetsProvider(log, config);
  });

  beforeEach(async function () {
    errorWindows.length = 0;
    await just.forget();
    config.set("export.cslStyle", "");
    config.set("export.cslLibrary", "");

    root = await mkdtemp(path.join(tmpdir(), "zettlr-export-document-"));
    document = path.join(root, "Lattices.md");
    await writeFile(document, DOCUMENT);
    await mkdir(path.join(root, "figures"));
    await writeFile(path.join(root, "figures", "gram.png"), "the bytes of a figure");
    await mkdir(path.join(root, "sections"));
    await writeFile(path.join(root, "Sections.md"), declaring("sections"));
    await writeFile(path.join(root, "Absent.md"), declaring("no-such-folder"));

    await mkdir(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    fsal = await bootFsal(root);
    documents = await bootDocumentManager([root]);

    const log = new LogProvider();
    services = {
      documents,
      fsal,
      assets,
      config,
      log,
      lrt: new LongRunningTaskProvider(log),
      links: {
        index: new WikilinkIndex([{ path: document, root, id: "", title: undefined, aliases: [] }]),
      },
      windows: {
        askDir: async () => {
          throw new Error("No export of this spec asks for a folder");
        },
        showErrorMessage: (title: string, message: string, contents?: string) => {
          errorWindows.push({ title, message, contents });
        },
      },
    };
  });

  afterEach(async function () {
    await documents.shutdown();
    await fsal.shutdown();
    await rm(root, { recursive: true });
  });

  after(async function () {
    await assets.shutdown();
    await just.remove();
    await rm(scripts, { recursive: true });
    await rm(macroHome, { recursive: true });
  });

  describe("with unsaved text", function () {
    beforeEach(async function () {
      await typeUnsaved(document);
    });

    it("puts the unsaved text and the figures of the document into a textbundle", async function () {
      await exportDocument(services, { file: document, profile: TEXTBUNDLE, exportTo: "cwd" });

      assert.deepEqual(errorWindows, []);
      const bundle = path.join(root, "Lattices.textbundle");
      const text = await readFile(path.join(bundle, "text.md"), "utf8");
      assert.equal(text.startsWith(UNSAVED), true, "the bundle has the text on disk");
      assert.equal(
        await readFile(path.join(bundle, "assets", "gram.png"), "utf8"),
        "the bytes of a figure",
      );
      assert.equal(text.includes("](assets/gram.png)"), true);
    });

    it("runs the PDF recipe on the unsaved text in the folder of the document", async function () {
      await exportDocument(services, { file: document, profile: PDF, exportTo: "cwd" });

      assert.deepEqual(errorWindows, []);
      assert.equal((await just.onlyRun()).cwd, root);
      assert.equal(await just.inputText(), `${UNSAVED}${DOCUMENT}`);
      assert.equal(existsSync(path.join(root, "Lattices.pdf")), true);
    });

    it("resolves a wikilink of the unsaved text to the document", async function () {
      await exportDocument(services, { file: document, profile: PDF, exportTo: "cwd" });

      assert.deepEqual(JSON.parse(await just.wikilinkMap()), {
        inputs: [{ headings: 2 }],
        links: { "Lattices#Genus": { input: 0, heading: 1 } },
      });
    });
  });

  it("leaves no file of unsaved text in the temporary directory", async function () {
    // A name that no other export of this spec has.
    const notes = path.join(root, "Notes.md");
    await writeFile(notes, DOCUMENT);
    await typeUnsaved(notes);
    const before = await readdir(tmpdir());

    await exportDocument(services, { file: notes, profile: PDF, exportTo: "cwd" });

    assert.deepEqual(errorWindows, []);
    assert.deepEqual(await readdir(tmpdir()), before);
  });

  it("gives the PDF recipe the name of a document whose text is on disk", async function () {
    await exportDocument(services, { file: document, profile: PDF, exportTo: "cwd" });

    assert.deepEqual(errorWindows, []);
    assert.deepEqual(await just.onlyRun(), {
      cwd: root,
      argv: ["--justfile", RECIPE_FILE, "compile-pandoc", "Lattices.md", "Lattices"],
    });
  });

  it("reads a declared working directory from the folder of the document", async function () {
    await exportDocument(services, {
      file: path.join(root, "Sections.md"),
      profile: WORKING_DIRECTORY,
      exportTo: "cwd",
    });

    assert.deepEqual(errorWindows, []);
    assert.equal(
      await readFile(path.join(root, "Sections.txt"), "utf8"),
      `${path.join(root, "sections")}\n`,
    );
  });

  it("refuses an export whose declared working directory is absent", async function () {
    await exportDocument(services, {
      file: path.join(root, "Absent.md"),
      profile: PDF,
      exportTo: "cwd",
    });

    assert.equal(errorWindows.length, 1, "one refused export opens one error window");
    assert.equal(shownText().includes(path.join(root, "no-such-folder")), true);
    assert.deepEqual(await just.runs(), []);
  });

  it("refuses an export when the citation style of the settings is no file", async function () {
    const style = path.join(root, "no-such-style.csl");
    config.set("export.cslStyle", style);

    await exportDocument(services, { file: document, profile: LATEX, exportTo: "cwd" });

    assert.equal(errorWindows.length, 1, "one refused export opens one error window");
    assert.equal(shownText().includes(style), true);
    assert.equal(existsSync(path.join(root, "Lattices.tex")), false);
  });

  it("refuses an export when the citation library of the settings is no file", async function () {
    const library = path.join(root, "no-such-library.bib");
    config.set("export.cslLibrary", library);

    await exportDocument(services, { file: document, profile: LATEX, exportTo: "cwd" });

    assert.equal(errorWindows.length, 1, "one refused export opens one error window");
    assert.equal(shownText().includes(library), true);
    assert.equal(existsSync(path.join(root, "Lattices.tex")), false);
  });

  it("exports the LaTeX delimiters of math as math to LaTeX", async function () {
    const forms = path.join(root, "Forms.md");
    await writeFile(forms, BRACKET_MATH);

    await exportDocument(services, { file: forms, profile: LATEX, exportTo: "cwd" });

    assert.deepEqual(errorWindows, []);
    const body = (await readFile(path.join(root, "Forms.tex"), "utf8")).split("\n");
    assert.equal(body.includes("The form \\(q(x) = x^2\\) has"), true, "inline math");
    assert.equal(body.includes("\\[\\Delta = 4\\]"), true, "display math");
  });

  it("exports the LaTeX delimiters of math as math to Word", async function () {
    const forms = path.join(root, "Forms.md");
    await writeFile(forms, BRACKET_MATH);

    await exportDocument(services, { file: forms, profile: WORD, exportTo: "cwd" });

    assert.deepEqual(errorWindows, []);
    const xml = execFileSync("unzip", ["-p", path.join(root, "Forms.docx"), "word/document.xml"], {
      encoding: "utf8",
    });
    // Word math is Office Math: one inline and one display formula.
    assert.equal(xml.match(/<m:oMath>/g)?.length, 2);
    assert.equal(xml.match(/<m:oMathPara>/g)?.length, 1);
  });
});
