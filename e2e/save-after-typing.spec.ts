/**
 * Assembled-app proof that File → Save writes every character typed before
 * it. The editor sends typed text to the main process in batches, and the
 * main process writes the text it holds; a save right after typing must
 * still write the whole buffer.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
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

describe("assembled app: Save right after typing", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-save-after-typing-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n",
      config: { darkMode: false },
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
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-save-after-typing-e2e-latest"),
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

  it("writes every typed character when Save follows the typing at once", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    await editorPage.locator(".cm-content").click();
    let expected = "# Note\n";
    // One round loses its last characters only sometimes; ten rounds make
    // the loss show on most runs of a save path that does not wait.
    for (let round = 1; round <= 10; round++) {
      const sentence = `Round ${round} ends here.`;
      expected = `${expected}${sentence}`;
      await editorPage.keyboard.press("ControlOrMeta+End");
      await editorPage.keyboard.type(sentence);
      // File → Save: the menu item that Ctrl+S runs.
      await editorPage.evaluate(() => {
        window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
      });

      // The save replaces the content of the file in place: a read during
      // the write can give an empty or a partial file. The text that the
      // file has when it stops changing is the text that the save wrote.
      const deadline = Date.now() + 5_000;
      let written = await readFile(documentPath, "utf8");
      while (written !== expected && Date.now() < deadline) {
        await delay(50);
        written = await readFile(documentPath, "utf8");
      }
      assert.equal(written, expected, `Round ${round} saved other text than the editor held`);
    }
    screenshots.set("after-save.png", await editorPage.screenshot());
  });
});
