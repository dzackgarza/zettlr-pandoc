/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the Project export
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A Project export runs each profile of the Project. The
 *                  author gets the success message only when each profile
 *                  exported, and one message that names each profile that
 *                  did not. These tests run the real export over the real
 *                  FSAL, with export commands that are real processes.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import AssetsProvider from "source/app/service-providers/assets";
import {
  exportProject,
  type ProjectExportServices,
} from "source/app/service-providers/commands/dir-project-export";
import ConfigProvider from "source/app/service-providers/config";
import type FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import LongRunningTaskProvider from "source/app/service-providers/long-running-tasks";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { bootFilteredFsal, bootFsal } from "./fsal-seam";
import { messageBoxes, notifications, userData } from "./headless-electron-harness.cjs";
import { installRecordingJust, type RecordingJust } from "./recording-just";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

const CHAPTER = "# Genus\n\nTwo forms of one genus.\n";

/** What the first failing command writes to its error output. */
const NO_ENGINE = "the engine of the first command is absent";

/** What the second failing command writes to its error output. */
const NO_TEMPLATE = "the template of the second command is absent";

/** The first line of the TeX template of a Project. */
const TEMPLATE_MARK = "% the template of the Project";

/** The recipe file that a PDF export runs. */
const RECIPE_FILE = path.join(homedir(), ".pandoc", "justfile");

/** What a Project of this spec has. */
interface ProjectFixture {
  /** The entries of its profile list. */
  profiles: string[];
  /** Its chapters, in the order of the export. */
  chapters: string[];
  /** The TeX template of its settings. */
  texTemplate: string;
  /** The citation style of its settings. */
  cslStyle: string;
}

/** An error window that the command opened. */
interface ErrorWindow {
  title: string;
  message: string;
  contents: string | undefined;
}

describe("Project export", function () {
  let root: string;
  let scripts: string;
  let macroHome: string;
  let fsal: FSAL;
  let assets: AssetsProvider;
  let services: ProjectExportServices;
  const errorWindows: ErrorWindow[] = [];

  /** An export command of the configuration: a script of this spec. */
  async function exportCommand(name: string, body: string): Promise<string> {
    const script = path.join(scripts, name);
    await writeFile(script, `#!/bin/sh\n${body}\n`);
    await chmod(script, 0o755);
    return script;
  }

  /** A Project folder. Its title is its name. */
  async function project(name: string, fixture: ProjectFixture): Promise<string> {
    const directory = path.join(root, name);
    await mkdir(directory);
    for (const chapter of fixture.chapters) {
      await writeFile(path.join(directory, chapter), CHAPTER);
    }
    await writeFile(
      path.join(directory, ".ztr-directory"),
      JSON.stringify({
        sorting: "name-up",
        project: {
          title: name,
          profiles: fixture.profiles,
          files: fixture.chapters,
          cslStyle: fixture.cslStyle,
          templates: { tex: fixture.texTemplate, html: "" },
        },
        icon: null,
        color: null,
      }),
    );
    return directory;
  }

  let oneFailed: string;
  let twoFailed: string;
  let allExported: string;
  let apostrophe: string;
  let template: string;
  let pdfOfChapters: string;
  let pdfOfOneChapter: string;
  let latex: string;
  let absentStyle: string;
  let styleIsNoFile: string;
  let refusedFolder: string;
  let refusedPart: string;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-project-export-"));
    scripts = await mkdtemp(path.join(tmpdir(), "zettlr-project-export-commands-"));

    const noEngine = await exportCommand("no-engine.sh", `echo "${NO_ENGINE}" >&2\nexit 3`);
    const noTemplate = await exportCommand("no-template.sh", `echo "${NO_TEMPLATE}" >&2\nexit 4`);
    // The command gets the Project folder as its argument.
    const listing = await exportCommand("listing.sh", 'ls "$1" > "$1/listing.txt"');

    const chapters = ["chapter.md"];
    oneFailed = await project("one-failed", {
      profiles: [noEngine, listing],
      chapters,
      texTemplate: "",
      cslStyle: "",
    });
    twoFailed = await project("two-failed", {
      profiles: [noEngine, noTemplate],
      chapters,
      texTemplate: "",
      cslStyle: "",
    });
    allExported = await project("all-exported", {
      profiles: [listing],
      chapters,
      texTemplate: "",
      cslStyle: "",
    });
    apostrophe = await project("Halphen's pencils", {
      profiles: [listing],
      chapters,
      texTemplate: "",
      cslStyle: "",
    });

    template = path.join(scripts, "thesis.tex");
    await writeFile(template, `${TEMPLATE_MARK}\n$body$\n`);
    pdfOfChapters = await project("pdf-of-chapters", {
      profiles: ["PDF.yaml"],
      chapters: ["one.md", "two.md"],
      texTemplate: template,
      cslStyle: "",
    });
    pdfOfOneChapter = await project("pdf-of-one-chapter", {
      profiles: ["PDF.yaml"],
      chapters,
      texTemplate: template,
      cslStyle: "",
    });
    latex = await project("latex", {
      profiles: ["LaTeX.yaml"],
      chapters,
      texTemplate: template,
      cslStyle: "",
    });
    absentStyle = path.join(scripts, "no-such-style.csl");
    styleIsNoFile = await project("style-is-no-file", {
      profiles: ["LaTeX.yaml"],
      chapters,
      texTemplate: "",
      cslStyle: absentStyle,
    });

    // A Project whose second chapter is in a folder that refuses its search:
    // the file cannot be examined.
    refusedFolder = await project("refused-folder", {
      profiles: [listing],
      chapters,
      texTemplate: "",
      cslStyle: "",
    });
    refusedPart = path.join(refusedFolder, "part");
    await mkdir(refusedPart);
    await writeFile(path.join(refusedPart, "two.md"), CHAPTER);
    const settingsFile = path.join(refusedFolder, ".ztr-directory");
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    settings.project.files = ["chapter.md", "part/two.md"];
    await writeFile(settingsFile, JSON.stringify(settings));
    await chmod(refusedPart, 0o000);

    // An export with pandoc reads the macro projection of the home directory.
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

    const log = new LogProvider();
    const config = new ConfigProvider(
      log,
      [path.resolve("static", "lang")],
      unexpectedStoreWriteFailure,
    );
    config.set("export.customCommands", [
      { displayName: "First command", command: noEngine },
      { displayName: "Second command", command: noTemplate },
      { displayName: "Listing", command: listing },
    ]);
    assets = new AssetsProvider(log, config);
    fsal = await bootFsal(root);

    services = {
      fsal,
      assets,
      config,
      log,
      lrt: new LongRunningTaskProvider(log),
      // No document of these Projects has a wikilink.
      links: { index: new WikilinkIndex([]) },
      windows: {
        showErrorMessage: (title: string, message: string, contents?: string) => {
          errorWindows.push({ title, message, contents });
        },
      },
    };
  });

  beforeEach(function () {
    errorWindows.length = 0;
    notifications.shown.length = 0;
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;
  });

  after(async function () {
    await chmod(refusedPart, 0o755);
    await fsal.shutdown();
    await assets.shutdown();
    await rm(root, { recursive: true });
    await rm(scripts, { recursive: true });
    await rm(macroHome, { recursive: true });
  });

  it("shows the success message when each profile exported", async function () {
    const exported = await exportProject(services, allExported);

    assert.equal(exported, true);
    assert.equal(notifications.shown.length, 1);
    assert.deepEqual(errorWindows, []);
  });

  it("shows no success message when a profile did not export", async function () {
    const exported = await exportProject(services, oneFailed);

    assert.deepEqual(notifications.shown, []);
    assert.equal(exported, false);
  });

  it("runs the other profiles of a Project with a profile that did not export", async function () {
    await exportProject(services, oneFailed);

    assert.match(await readFile(path.join(oneFailed, "listing.txt"), "utf8"), /^chapter\.md$/m);
  });

  it("names each profile that did not export in one message", async function () {
    await exportProject(services, twoFailed);

    assert.equal(errorWindows.length, 1, "one failure of an export opens one error window");
    const [shown] = errorWindows;
    for (const part of ["First command", "Second command", NO_ENGINE, NO_TEMPLATE]) {
      assert.ok(
        `${shown.message}\n${shown.contents}`.includes(part),
        `the message has no "${part}"`,
      );
    }
  });

  it("gives a command a Project folder with an apostrophe in its name", async function () {
    const exported = await exportProject(services, apostrophe);

    assert.deepEqual(errorWindows, []);
    assert.equal(exported, true);
    assert.match(await readFile(path.join(apostrophe, "listing.txt"), "utf8"), /^chapter\.md$/m);
  });

  it("does not export with a citation style of the Project that is no file", async function () {
    const exported = await exportProject(services, styleIsNoFile);

    assert.equal(exported, false);
    assert.equal(errorWindows.length, 1, "one failure of an export opens one error window");
    const [shown] = errorWindows;
    assert.equal(`${shown.message}\n${shown.contents}`.includes(absentStyle), true);
    assert.equal(existsSync(path.join(styleIsNoFile, "style-is-no-file.tex")), false);
  });

  it("names a chapter folder that refuses its content in the message of missing files", async function () {
    messageBoxes.answer = 0;
    await exportProject(services, refusedFolder);

    assert.equal(messageBoxes.shown.length, 1, "the export shows one message of missing files");
    const [shown] = messageBoxes.shown;
    const text = `${shown.message}\n${shown.detail}`;
    assert.ok(text.includes("part/two.md"), `the message does not name the chapter: ${text}`);
    assert.ok(text.includes(refusedPart), `the message does not name the folder: ${text}`);
    assert.ok(text.includes("EACCES"), `the message does not give the cause: ${text}`);
  });

  describe("with a TeX template in the settings of the Project", function () {
    let just: RecordingJust;

    before(async function () {
      just = await installRecordingJust();
    });

    beforeEach(async function () {
      await just.forget();
    });

    after(async function () {
      await just.remove();
    });

    /** The arguments of each recipe run, in the order of the runs. */
    async function recipeRuns(): Promise<string[][]> {
      return (await just.runs()).map((run) => run.argv);
    }

    it("gives the recipe the template for a PDF of several chapters", async function () {
      const exported = await exportProject(services, pdfOfChapters);

      assert.deepEqual(errorWindows, []);
      assert.equal(exported, true);
      assert.deepEqual(await recipeRuns(), [
        [
          "--justfile",
          RECIPE_FILE,
          "compile-pandoc-project",
          "pdf-of-chapters",
          template,
          "one.md",
          "two.md",
        ],
      ]);
    });

    it("runs the recipe for a PDF when the profiles of the author hold an old PDF.yaml", async function () {
      // userData/defaults is copied once and never pruned. Versions before the
      // PDF recipe shipped a PDF.yaml with the pandoc PDF writer.
      const stale = path.join(userData, "defaults", "PDF.yaml");
      await writeFile(stale, "reader: markdown\nwriter: pdf\npdf-engine: pdflatex\n");

      const exported = await exportProject(services, pdfOfChapters);
      await rm(stale);

      assert.deepEqual(errorWindows, []);
      assert.equal(exported, true);
      assert.deepEqual(await recipeRuns(), [
        [
          "--justfile",
          RECIPE_FILE,
          "compile-pandoc-project",
          "pdf-of-chapters",
          template,
          "one.md",
          "two.md",
        ],
      ]);
    });

    it("gives the recipe the template for a PDF of one chapter", async function () {
      const exported = await exportProject(services, pdfOfOneChapter);

      assert.deepEqual(errorWindows, []);
      assert.equal(exported, true);
      assert.deepEqual(await recipeRuns(), [
        ["--justfile", RECIPE_FILE, "compile-pandoc", "chapter.md", "pdf-of-one-chapter", template],
      ]);
    });

    it("gives the recipe a chapter that a rule of the file filters hides", async function () {
      // The application starts with the file filters on. The workspace hides
      // the drafts folder of the book; the book still has its chapter there.
      const filteredRoot = await mkdtemp(path.join(tmpdir(), "zettlr-project-export-filtered-"));
      const book = path.join(filteredRoot, "book");
      await mkdir(path.join(book, "drafts"), { recursive: true });
      await writeFile(path.join(filteredRoot, ".zettlrignore"), "drafts/\n");
      await writeFile(path.join(book, "one.md"), CHAPTER);
      await writeFile(path.join(book, "drafts", "two.md"), CHAPTER);
      await writeFile(
        path.join(book, ".ztr-directory"),
        JSON.stringify({
          sorting: "name-up",
          project: {
            title: "book",
            profiles: ["PDF.yaml"],
            files: ["one.md", "drafts/two.md"],
            cslStyle: "",
            templates: { tex: template, html: "" },
          },
          icon: null,
          color: null,
        }),
      );
      const filtered = await bootFilteredFsal(filteredRoot);
      messageBoxes.answer = 0;

      const exported = await exportProject({ ...services, fsal: filtered }, book);
      await filtered.shutdown();
      await rm(filteredRoot, { recursive: true });

      assert.deepEqual(messageBoxes.shown, [], "the export says that no chapter is missing");
      assert.equal(exported, true);
      assert.deepEqual(await recipeRuns(), [
        [
          "--justfile",
          RECIPE_FILE,
          "compile-pandoc-project",
          "book",
          template,
          "one.md",
          "drafts/two.md",
        ],
      ]);
    });

    it("makes a LaTeX document with the template", async function () {
      const exported = await exportProject(services, latex);

      assert.deepEqual(errorWindows, []);
      assert.equal(exported, true);
      const document = await readFile(path.join(latex, "latex.tex"), "utf8");
      assert.equal(document.split("\n")[0], TEMPLATE_MARK);
    });
  });
});
