/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Print window of a document with unsaved text
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author types in a document and prints it before a
 *                  save. The print window shows the text of the document,
 *                  which is not on disk. A document whose file another
 *                  program removed stays open with its text (§14), and its
 *                  print window shows that text too.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-print-unsaved-text-e2e-latest");
const CONTENTS = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const TYPED = "The Leech lattice has rank 24.";
const AFTER_REMOVAL = " It has no roots.";
const TOAST = "#zettlr-toast-container .zettlr-toast";
const EDITOR = ".cm-content:visible";

function printPages(browser: Browser): Page[] {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => !candidate.isClosed() && candidate.url().includes("/print/"));
}

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

describe("a print window of a document with unsaved text", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-print-unsaved-text-e2e-", {
      documentName: "lattices.md",
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

    await page.locator(EDITOR).waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    // The application quits when its last window closes, so the print window
    // closes before the main window does.
    for (const printPage of printPages(requireInitialized(browser, "browser"))) {
      const closed = printPage.waitForEvent("close", { timeout: 10_000 });
      await requestWindowClose(printPage);
      await closed;
    }
    // A quit asks about a document with unsaved text; the save writes the
    // file again, and the quit asks nothing.
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
    });
    const saved = Date.now() + 10_000;
    while ((await modifiedDocuments(editorPage)).length > 0) {
      assert.ok(Date.now() < saved, "the document was saved before the quit");
      await delay(100);
    }
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

  /** Opens the print window of the document, and answers the text of its last paragraph. */
  async function printedParagraph(screenshot: string): Promise<string> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.evaluate(async (filePath) => {
      await window.ipc.invoke("application", { command: "print", payload: filePath });
    }, documentPath);
    const openBrowser = requireInitialized(browser, "browser");
    const deadline = Date.now() + 20_000;
    let printPage = printPages(openBrowser)[0];
    while (printPage === undefined) {
      assert.ok(Date.now() < deadline, "the print window opened");
      await delay(100);
      printPage = printPages(openBrowser)[0];
    }
    const paragraph = printPage.locator("#print-container p").last();
    await paragraph.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set(screenshot, await printPage.screenshot());
    // The typed sentence is a second line of the paragraph.
    const text = (await paragraph.innerText()).replace(/\s+/g, " ");
    const closed = printPage.waitForEvent("close", { timeout: 10_000 });
    await requestWindowClose(printPage);
    await closed;
    return text;
  }

  it("shows the text that the author typed and did not save", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.locator(EDITOR).click();
    await editorPage.keyboard.press("ControlOrMeta+End");
    await editorPage.keyboard.type(TYPED);

    assert.equal(
      await printedParagraph("unsaved.png"),
      `An even unimodular lattice has a rank that 8 divides. ${TYPED}`,
    );
  });

  it("shows the text of a document whose file another program removed", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await rm(documentPath);
    const removed = editorPage.locator(TOAST).filter({ hasText: "removed from disk" });
    await removed.first().waitFor({ state: "visible", timeout: 30_000 });
    await editorPage.locator(EDITOR).click();
    await editorPage.keyboard.press("ControlOrMeta+End");
    await editorPage.keyboard.type(AFTER_REMOVAL);

    assert.equal(
      await printedParagraph("removed.png"),
      `An even unimodular lattice has a rank that 8 divides. ${TYPED}${AFTER_REMOVAL}`,
    );
  });
});
