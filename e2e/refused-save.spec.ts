/**
 * Assembled-app proof that a save which cannot write the file loses no
 * text and leaves the author a next step. The file of the open document
 * loses its write permission, so the running application meets the error
 * that a read-only disk gives. The window names the file and offers a copy
 * of the text. The action "Save a copy…" asks for a file in a native
 * dialog and writes the text of the editor to it; the document stays
 * modified, and the same save writes the text when the file can be written
 * again (#178, #210).
 *
 * The spec answers a native dialog, so it runs on the display of the run
 * only.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";
import { captureWindow, nativeDialog, pressKey, searchWindows } from "./support/native-dialog";

const CONTENTS = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const SENTENCE = "The Leech lattice has rank 24.";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const INFO_TOAST = "#zettlr-toast-container .zettlr-toast.info";
const SAVE_DIALOG_TITLE = "Save file";

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

describe("assembled app: a save that cannot write the file", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-refused-save-e2e-", {
      documentName: "note.md",
      documentContents: CONTENTS,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await chmod(documentPath, 0o600);
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-refused-save-e2e-latest"),
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assertCleanExit(getOutput());
  });

  it("keeps the text, names the file and offers a copy of the text", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    await chmod(documentPath, 0o400);
    await editorPage.locator(".cm-content").click();
    await editorPage.keyboard.press("ControlOrMeta+End");
    await editorPage.keyboard.type(SENTENCE);

    await save(editorPage);

    const toast = editorPage.locator(ERROR_TOAST);
    const action = toast.first().locator("[data-toast-action]");
    await action.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("save-refused.png", await editorPage.screenshot());
    assert.equal(await toast.count(), 1, "one refused save shows one message");
    assert.equal(await action.innerText(), "Save a copy…");
    const message = await toast.first().locator("span:first-child").innerText();
    assert.ok(message.includes("note.md"), `the message names the file: ${message}`);
    assert.equal(await readFile(documentPath, "utf8"), CONTENTS, "nothing was written");
    assert.deepEqual(
      await modifiedDocuments(editorPage),
      [documentPath],
      "the document has text that is not on disk, so it is modified",
    );

    // The copy: the dialog proposes a file beside the document. The mnemonic
    // of its Save button accepts the proposal; the Return key does not, with
    // the focus in the name field of a GTK file chooser.
    const copyPath = path.join(path.dirname(documentPath), "note copy.md");
    await action.click();
    const dialog = await nativeDialog(SAVE_DIALOG_TITLE, 30_000);
    screenshots.set("save-copy-dialog.png", await captureWindow(dialog));
    await pressKey(dialog, "alt+s");
    const dialogDeadline = Date.now() + 30_000;
    while ((await searchWindows(["--name", `^${SAVE_DIALOG_TITLE}$`])).length > 0) {
      assert.ok(Date.now() < dialogDeadline, "the dialog closes when its Save button is used");
      await delay(250);
    }
    const copied = editorPage.locator(INFO_TOAST, { hasText: "note copy.md" });
    await copied.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("copy-saved.png", await editorPage.screenshot());
    assert.equal(
      await readFile(copyPath, "utf8"),
      `${CONTENTS}${SENTENCE}`,
      "the copy has the text of the editor",
    );
    assert.equal(await readFile(documentPath, "utf8"), CONTENTS, "the document file is as it was");
    assert.deepEqual(
      await modifiedDocuments(editorPage),
      [documentPath],
      "a copy does not save the document",
    );
    assert.equal(
      await editorPage.locator(`[role="tab"][data-path="${documentPath}"].active`).count(),
      1,
      "the editor still shows the document, not the copy",
    );

    // The application kept the text: the same save writes it when the file
    // can be written again. The focus is where the click on the message left
    // it, outside the editor.
    await chmod(documentPath, 0o600);
    await save(editorPage);
    const expected = `${CONTENTS}${SENTENCE}`;
    const deadline = Date.now() + 10_000;
    let written = await readFile(documentPath, "utf8");
    while (written !== expected && Date.now() < deadline) {
      await delay(50);
      written = await readFile(documentPath, "utf8");
    }
    assert.equal(written, expected, "the save after the repair writes the text of the editor");
    assert.deepEqual(await modifiedDocuments(editorPage), [], "the document is saved");
  });
});
