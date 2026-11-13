/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a removed file with unsaved text
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author typed text that is not on disk, and another
 *                  program removes the file of the document. The text is
 *                  only in the application then. The document stays open
 *                  with its text, the window says one time that the file was
 *                  removed, a save writes the file again, and the
 *                  application follows the new file.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-external-delete-unsaved-e2e-latest");
const CONTENTS = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const SENTENCE = "The Leech lattice has rank 24.";
const REPLACEMENT = "# Genera\n\nTwo forms of one genus are isometric over each completion.\n";
const TOAST = "#zettlr-toast-container .zettlr-toast";
/** The editor of the tab that a pane shows; a pane keeps a hidden editor for each other tab. */
const EDITOR = ".cm-content:visible";
/** The application handles the event of a write of its own before this time ends. */
const OWN_WRITE_HANDLED_MS = 3_000;

/** File → Save: the menu item that Ctrl+S runs. */
async function save(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
  });
}

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

/** The text of a file, or nothing for a file that is not there. */
function textOnDisk(filePath: string): Promise<string | undefined> {
  return readFile(filePath, "utf8").then(
    (text) => text,
    () => undefined,
  );
}

describe("a file that another program removes while its document has unsaved text", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-external-delete-unsaved-e2e-", {
      documentName: "note.md",
      documentContents: CONTENTS,
      config: { editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(EDITOR).waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await shutdown(browser, appProcess);
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

  it("keeps the document with its text and says that the file was removed", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.locator(EDITOR).click();
    await editorPage.keyboard.press("ControlOrMeta+End");
    await editorPage.keyboard.type(SENTENCE);
    assert.deepEqual(await modifiedDocuments(editorPage), [documentPath]);

    await rm(documentPath);
    const removed = editorPage.locator(TOAST).filter({ hasText: "removed from disk" });
    const withText = editorPage.locator(EDITOR).filter({ hasText: SENTENCE });
    const deadline = Date.now() + 30_000;
    while ((await removed.count()) === 0 && (await withText.count()) === 1) {
      assert.ok(Date.now() < deadline, "the application noticed that the file was removed");
      await delay(250);
    }
    await delay(1_000);
    screenshots.set("file-removed.png", await editorPage.screenshot());

    assert.equal(await withText.count(), 1, "the editor keeps the text that is not on disk");
    assert.equal(await removed.count(), 1, "the window says one time that the file was removed");
    const message = await removed.first().locator("span:first-child").innerText();
    assert.ok(message.includes("note.md"), `the message names the file: ${message}`);
    assert.deepEqual(
      await modifiedDocuments(editorPage),
      [documentPath],
      "the document has text that is not on disk, so it is modified",
    );
  });

  it("writes the file again at a save and follows the new file", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await save(editorPage);
    const expected = `${CONTENTS}${SENTENCE}`;
    const written = Date.now() + 10_000;
    while ((await textOnDisk(documentPath)) !== expected && Date.now() < written) {
      await delay(50);
    }
    assert.equal(await textOnDisk(documentPath), expected, "the save writes the file again");
    assert.deepEqual(await modifiedDocuments(editorPage), [], "the document is saved");

    // The file of the save is a new file. A change that another program
    // makes to it reaches the document, as for a file that was never removed.
    await delay(OWN_WRITE_HANDLED_MS);
    await writeFile(documentPath, REPLACEMENT);
    const replaced = editorPage.locator(EDITOR).filter({ hasText: "Two forms of one genus" });
    const followed = Date.now() + 30_000;
    while ((await replaced.count()) === 0 && Date.now() < followed) {
      await delay(250);
    }
    screenshots.set("new-file-followed.png", await editorPage.screenshot());
    assert.equal(await replaced.count(), 1, "the editor shows the text that the file now has");
  });
});
