/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of folders whose metadata cannot be used
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace holds a folder whose settings file has the
 *                  markers of a merge conflict, a folder whose Quarto
 *                  manifest is not YAML, a folder with the manifest of a
 *                  Quarto website, and a folder that refuses its content.
 *                  The application starts, lists each folder, and names
 *                  the cause on the row and in the properties of the
 *                  folder. A change of the settings is refused and the
 *                  file of the author keeps its bytes. A repaired file
 *                  takes the mark away.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-folder-metadata-problems-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const CHAPTER = "# Genera\n\nTwo forms of one genus are isometric over each completion.\n";
/** A settings file as a merge leaves it when both sides changed the sorting. */
const CONFLICTED_SETTINGS = [
  "<<<<<<< HEAD",
  '{"sorting":"time-down","icon":"book"}',
  "=======",
  '{"sorting":"name-down","icon":"book"}',
  ">>>>>>> theirs",
  "",
].join("\n");
const REPAIRED_SETTINGS = '{"sorting":"time-down","icon":"book"}';
/** A manifest with a flow sequence that has no end. */
const DRAFT_MANIFEST = "project:\n  type: book\nbook:\n  chapters: [intro.md\n";
const REPAIRED_MANIFEST =
  'project:\n  type: book\nbook:\n  title: "Draft"\n  chapters:\n    - intro.md\n';
const WEBSITE_MANIFEST = 'project:\n  type: website\nwebsite:\n  title: "Notes"\n';
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const POPOVER = "#dir-props";
/** The time in which a second message of one failure arrives. */
const SECOND_MESSAGE_MS = 2_000;

describe("folders whose metadata cannot be used", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let conflicted = "";
  let draftBook = "";
  let site = "";
  let locked = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-folder-metadata-problems-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { darkMode: false, window: { fileManagerVisible: true } },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    conflicted = path.join(workspace, "conflicted");
    draftBook = path.join(workspace, "draft-book");
    site = path.join(workspace, "site");
    locked = path.join(workspace, "locked");
    for (const folder of [conflicted, draftBook, site, locked]) {
      await mkdir(folder);
    }
    await writeFile(path.join(conflicted, ".ztr-directory"), CONFLICTED_SETTINGS, "utf8");
    await writeFile(path.join(conflicted, "chapter.md"), CHAPTER, "utf8");
    await writeFile(path.join(draftBook, "_quarto.yml"), DRAFT_MANIFEST, "utf8");
    await writeFile(path.join(draftBook, "intro.md"), CHAPTER, "utf8");
    await writeFile(path.join(site, "_quarto.yml"), WEBSITE_MANIFEST, "utf8");
    await writeFile(path.join(site, "index.md"), CHAPTER, "utf8");
    await writeFile(path.join(locked, "private.md"), CHAPTER, "utf8");
    await chmod(locked, 0o000);

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    await page.setViewportSize({ width: 1500, height: 950 });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    if (locked !== "") {
      await chmod(locked, 0o700);
    }
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  /** The row of a folder in the file manager. */
  function folderRow(editorPage: Page, folderPath: string): Locator {
    return editorPage.locator(
      `#file-manager .tree-item.directory[data-path=${JSON.stringify(folderPath)}]`,
    );
  }

  /** What the row of a folder tells the author about the folder. */
  async function rowTitle(editorPage: Page, folderPath: string): Promise<string> {
    const title = await folderRow(editorPage, folderPath)
      .locator(".display-text")
      .getAttribute("title");
    return requireInitialized(title ?? undefined, `The row of ${folderPath} has a title`);
  }

  async function openFolderProperties(editorPage: Page, folderPath: string): Promise<void> {
    await folderRow(editorPage, folderPath).click({ button: "right" });
    const properties = editorPage.locator(
      '.application-menu .menu-item[data-id="menu.properties"]',
    );
    await properties.waitFor({ state: "visible", timeout: 10_000 });
    await properties.click();
    await editorPage.locator(POPOVER).waitFor({ state: "visible", timeout: 10_000 });
  }

  it("starts and lists each folder with its cause", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    for (const folder of [conflicted, draftBook, site, locked]) {
      await folderRow(editorPage, folder).waitFor({ state: "visible", timeout: 30_000 });
    }
    screenshots.set("listed.png", await editorPage.screenshot());

    assert.equal(
      await folderRow(editorPage, conflicted).getAttribute("data-metadata-problem"),
      "settings",
      "the folder with the conflicted settings file names its settings",
    );
    assert.equal(
      await folderRow(editorPage, draftBook).getAttribute("data-metadata-problem"),
      "manifest",
      "the folder with the manifest that is not YAML names its manifest",
    );
    assert.equal(
      await folderRow(editorPage, locked).getAttribute("data-metadata-problem"),
      "directory",
      "the folder that refuses its content names itself",
    );
    assert.equal(
      await folderRow(editorPage, site).getAttribute("data-metadata-problem"),
      null,
      "the manifest of a Quarto website is no problem of its folder",
    );

    const settingsFile = path.join(conflicted, ".ztr-directory");
    assert.ok(
      (await rowTitle(editorPage, conflicted)).includes(
        `The settings of this folder could not be read (${settingsFile}): `,
      ),
      "the row names the settings file",
    );
    assert.ok(
      (await rowTitle(editorPage, draftBook)).includes(
        `The Quarto book file ${path.join(draftBook, "_quarto.yml")} could not be used: `,
      ),
      "the row names the manifest",
    );
    assert.ok(
      (await rowTitle(editorPage, locked)).includes("This folder could not be read: EACCES"),
      "the row names the refusal of the filesystem",
    );
  });

  it("names the cause in the properties of the folder", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await openFolderProperties(editorPage, conflicted);
    const problems = editorPage.locator(`${POPOVER} .metadata-problems li`);
    screenshots.set("properties.png", await editorPage.screenshot());
    const sentences = await problems.allInnerTexts();
    assert.equal(sentences.length, 1, "the properties name one cause");
    assert.ok(
      sentences[0].includes(
        `The settings of this folder could not be read (${path.join(conflicted, ".ztr-directory")}): `,
      ),
      `the properties name the settings file: ${sentences[0]}`,
    );
  });

  it("refuses a change of the settings and keeps the file of the author", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const settingsFile = path.join(conflicted, ".ztr-directory");
    assert.deepEqual(
      await editorPage.locator(ERROR_TOAST).allInnerTexts(),
      [],
      "no error is shown before the change",
    );

    await editorPage.locator(`${POPOVER} select`).first().selectOption("time");

    const toast = editorPage.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 20_000 });
    await delay(SECOND_MESSAGE_MS);
    screenshots.set("refused-change.png", await editorPage.screenshot());
    const messages = await toast.locator("span:first-child").allInnerTexts();
    assert.equal(messages.length, 1, `the refusal is shown one time: ${messages.join(" | ")}`);
    assert.ok(
      messages[0].includes(
        `The settings of ${conflicted} were not changed: the settings file ${settingsFile} could not be read (`,
      ),
      `the message names the folder and the file: ${messages[0]}`,
    );
    assert.equal(
      await readFile(settingsFile, "utf8"),
      CONFLICTED_SETTINGS,
      "the settings file keeps the bytes of the author",
    );
    const shownSorting = await editorPage.locator(`${POPOVER} select`).first().inputValue();

    // A click outside the properties closes them.
    await toast.locator('button[aria-label="Dismiss"]').first().click();
    await toast.first().waitFor({ state: "hidden", timeout: 10_000 });
    await editorPage.locator(POPOVER).waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(shownSorting, "name", "the control shows the sorting that the folder has");
  });

  it("shows no Project after a refused change to a Project", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const project = editorPage.locator(`${POPOVER} #dir-props-project`);
    await openFolderProperties(editorPage, conflicted);

    await project.locator("label.switch").click();

    const toast = editorPage.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 20_000 });
    await delay(SECOND_MESSAGE_MS);
    screenshots.set("refused-project.png", await editorPage.screenshot());
    const messages = await toast.locator("span:first-child").allInnerTexts();
    const switchedOn = await project.locator('input[type="checkbox"]').isChecked();
    const offersBookFile = await project.locator("#select-quarto-manifest").count();

    await toast.locator('button[aria-label="Dismiss"]').first().click();
    await toast.first().waitFor({ state: "hidden", timeout: 10_000 });
    await editorPage.locator(POPOVER).waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(messages.length, 1, `the refusal is shown one time: ${messages.join(" | ")}`);
    assert.equal(switchedOn, false, "the switch shows that the folder is no Project");
    assert.equal(
      offersBookFile,
      1,
      "the properties offer what a folder without a Project has: the choice of a Quarto book file",
    );
    assert.equal(
      await readFile(path.join(conflicted, ".ztr-directory"), "utf8"),
      CONFLICTED_SETTINGS,
      "the settings file keeps the bytes of the author",
    );
  });

  it("takes the mark away when the author repairs the file", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await writeFile(path.join(conflicted, ".ztr-directory"), REPAIRED_SETTINGS, "utf8");
    await writeFile(path.join(draftBook, "_quarto.yml"), REPAIRED_MANIFEST, "utf8");

    await editorPage
      .locator(
        `#file-manager .tree-item.directory[data-path=${JSON.stringify(conflicted)}]:not([data-metadata-problem])`,
      )
      .waitFor({ state: "visible", timeout: 30_000 });
    await editorPage
      .locator(
        `#file-manager .tree-item.directory.project[data-path=${JSON.stringify(draftBook)}]:not([data-metadata-problem])`,
      )
      .waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("repaired.png", await editorPage.screenshot());
    assert.equal(
      await folderRow(editorPage, locked).getAttribute("data-metadata-problem"),
      "directory",
      "a folder that still refuses its content keeps its mark",
    );
  });
});
