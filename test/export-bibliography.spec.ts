/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the bibliography of a PDF export
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A PDF export cites from the bibliography of the document,
 *                  as the editor does (#198): the files that its front
 *                  matter names, else the bibliography of its Quarto book
 *                  and the main library. These tests run the real export
 *                  through the real ~/.pandoc recipe, pdflatex and biber, and
 *                  read the text of the PDF.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AssetsProvider, {
  BUNDLED_EXPORT_MATHJAX,
  type ValidPandocProfile,
} from "source/app/service-providers/assets";
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
import { unexpectedStoreWriteFailure } from "./store-write-failure";

const run = promisify(execFile);

const PDF: ValidPandocProfile = {
  name: "PDF.yaml",
  reader: "markdown",
  writer: "compile-pandoc",
  isInvalid: false,
};

/** The main library of the settings. */
const MAIN_LIBRARY = [
  "@book{milnor1973,",
  "  author = {Milnor, John and Husemoller, Dale},",
  "  title = {Symmetric Bilinear Forms},",
  "  publisher = {Springer},",
  "  year = {1973}",
  "}",
  "",
].join("\n");

/** The bibliography that the manifest of the book names. */
const BOOK_LIBRARY = [
  "@book{conway1988,",
  "  author = {Conway, John H. and Sloane, Neil J. A.},",
  "  title = {Sphere Packings, Lattices and Groups},",
  "  publisher = {Springer},",
  "  year = {1988}",
  "}",
  "",
].join("\n");

/** The bibliography that the front matter of a note names. */
const NOTE_LIBRARY = [
  "@book{serre1973,",
  "  author = {Serre, Jean-Pierre},",
  "  title = {A Course in Arithmetic},",
  "  publisher = {Springer},",
  "  year = {1973}",
  "}",
  "",
].join("\n");

const MANIFEST = [
  "project:",
  "  type: book",
  "book:",
  "  title: Lattices",
  "  chapters:",
  "    - index.md",
  "    - packings.md",
  "bibliography: book.bib",
  "",
].join("\n");

/** A chapter that cites from the book and from the main library. */
const CHAPTER =
  "# Packings\n\nThe densest packing in dimension eight is known [@conway1988]. Each even form has a signature that 8 divides [@milnor1973].\n";

/** A note whose front matter names its bibliography. */
const NOTE =
  "---\nbibliography: refs/local.bib\n---\n\n# Forms\n\nThe Hasse invariant is in [@serre1973].\n";

/** An error window that the export opened. */
interface ErrorWindow {
  title: string;
  message: string;
  contents: string | undefined;
}

describe("Bibliography of a PDF export", function () {
  // A run of pdflatex and biber over one document.
  this.timeout(300_000);

  let root: string;
  let macroHome: string;
  let fsal: FSAL;
  let documents: DocumentManager;
  let assets: AssetsProvider;
  let services: DocumentExportServices;
  let globalLibrary: string | undefined;
  const errorWindows: ErrorWindow[] = [];

  /** The text of the PDF that an export left in its folder. */
  async function pdfText(pdf: string): Promise<string> {
    const { stdout } = await run("pdftotext", [pdf, "-"]);
    return stdout.replace(/\s+/gu, " ");
  }

  before(async function () {
    // An export reads the macro projection of the home directory.
    macroHome = path.join(tmpdir(), ".pandoc");
    const projection = path.join(macroHome, "templates", "css");
    await mkdir(projection, { recursive: true });
    await copyFile(
      path.resolve("test", "fixtures", "mathjax-macros.json"),
      path.join(projection, "mathjax-macros.json"),
    );

    root = await mkdtemp(path.join(tmpdir(), "zettlr-export-bibliography-"));
    const mainLibrary = path.join(root, "main.bib");
    await writeFile(mainLibrary, MAIN_LIBRARY);

    // The recipe reads the main library of the author from
    // ZOTERO_GLOBAL_BIB when the export names no bibliography; it is the
    // file of the setting export.cslLibrary.
    globalLibrary = process.env.ZOTERO_GLOBAL_BIB;
    process.env.ZOTERO_GLOBAL_BIB = mainLibrary;

    const book = path.join(root, "book");
    await mkdir(book);
    await writeFile(path.join(book, "_quarto.yml"), MANIFEST);
    await writeFile(path.join(book, "book.bib"), BOOK_LIBRARY);
    await writeFile(path.join(book, "index.md"), "# Preface\n\nA book about lattices.\n");
    await writeFile(path.join(book, "packings.md"), CHAPTER);

    const notes = path.join(root, "notes");
    await mkdir(path.join(notes, "refs"), { recursive: true });
    await writeFile(path.join(notes, "refs", "local.bib"), NOTE_LIBRARY);
    await writeFile(path.join(notes, "forms.md"), NOTE);

    await mkdir(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });

    const log = new LogProvider();
    const config = new ConfigProvider(
      log,
      [path.resolve("static", "lang")],
      unexpectedStoreWriteFailure,
    );
    config.set("export.autoOpenExportedFiles", false);
    config.set("export.cslStyle", "");
    config.set("export.cslLibrary", mainLibrary);
    assets = new AssetsProvider(log, config, BUNDLED_EXPORT_MATHJAX);
    fsal = await bootFsal(root);
    documents = await bootDocumentManager([root]);

    services = {
      documents,
      fsal,
      assets,
      config,
      log,
      lrt: new LongRunningTaskProvider(log),
      links: { index: new WikilinkIndex([]) },
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

  beforeEach(function () {
    errorWindows.length = 0;
  });

  after(async function () {
    if (globalLibrary === undefined) {
      delete process.env.ZOTERO_GLOBAL_BIB;
    } else {
      process.env.ZOTERO_GLOBAL_BIB = globalLibrary;
    }
    await documents.shutdown();
    await fsal.shutdown();
    await assets.shutdown();
    await rm(root, { recursive: true });
    await rm(macroHome, { recursive: true });
  });

  it("cites a chapter of a Quarto book from the bibliography of the book", async function () {
    const chapter = path.join(root, "book", "packings.md");
    await exportDocument(services, { file: chapter, profile: PDF, exportTo: "cwd" });

    assert.deepEqual(errorWindows, []);
    const text = await pdfText(path.join(root, "book", "packings.pdf"));
    assert.ok(
      text.includes("Conway and Neil J. A. Sloane. Sphere Packings, Lattices and Groups"),
      `the references of the PDF do not hold the entry of the book: ${text}`,
    );
    assert.ok(
      text.includes("Milnor and Dale Husemoller. Symmetric Bilinear Forms"),
      `the references of the PDF do not hold the entry of the main library: ${text}`,
    );
  });

  it("cites a note from the bibliography that its front matter names", async function () {
    const note = path.join(root, "notes", "forms.md");
    await exportDocument(services, { file: note, profile: PDF, exportTo: "cwd" });

    assert.deepEqual(errorWindows, []);
    const text = await pdfText(path.join(root, "notes", "forms.pdf"));
    assert.ok(
      text.includes("Serre. A Course in Arithmetic"),
      `the references of the PDF do not hold the entry of the note: ${text}`,
    );
  });
});
