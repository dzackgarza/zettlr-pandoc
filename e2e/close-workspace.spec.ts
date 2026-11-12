/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Close of a workspace E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author closes a workspace from the context menu of
 *                  its row. Each document of the workspace closes with it,
 *                  also a document in a folder that the file filters hide.
 *                  A document with unsaved text asks first: the answer
 *                  Cancel leaves the workspace and the text, and the answer
 *                  No closes the workspace and writes nothing. The status
 *                  bar and the Outline then show no document (#210).
 *
 *                  The spec answers native message boxes, so it runs on the
 *                  display of the run only.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
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
import { captureWindow, nativeDialog, nativeDialogs, pressKey } from "./support/native-dialog";
import { leafIds, openInLeaf } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-close-workspace-e2e-latest");
const PROMPT_TITLE = "Unsaved changes";
const GENUS = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const HIDDEN = "# Draft\n\nA note in a folder that the file filters hide.\n";
const SENTENCE = " A sentence that the author did not save.";

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

/** The paths of the tabs of every pane of the window. */
async function openTabs(page: Page): Promise<string[]> {
  return await page.locator('[role="tab"][data-path]').evaluateAll((tabs) =>
    tabs.map((tab) => {
      // The selector holds only tabs with the attribute.
      const tabPath = tab.getAttribute("data-path");
      if (tabPath === null) {
        throw new Error("A tab of the selector has no data-path");
      }
      return tabPath;
    }),
  );
}

async function waitUntil(
  probe: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("assembled app: the close of a workspace", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let genusPath = "";
  let hiddenPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-close-workspace-e2e-", {
      documentName: "genus.md",
      documentContents: GENUS,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        fileManagerMode: "combined",
        window: { fileManagerVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    genusPath = fixture.documentPath;
    workspace = path.dirname(genusPath);
    hiddenPath = path.join(workspace, ".drafts", "draft.md");
    await mkdir(path.dirname(hiddenPath));
    await writeFile(hiddenPath, HIDDEN, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
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

  function workspaceRow(activePage: Page) {
    return activePage.locator(`.tree-item.directory[data-path=${JSON.stringify(workspace)}]`);
  }

  async function closeWorkspace(activePage: Page): Promise<void> {
    await workspaceRow(activePage).locator(".display-text").first().click({ button: "right" });
    const item = activePage
      .locator('.application-menu .menu-item[data-id="menu.close_workspace"]')
      .last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();
  }

  it("asks about unsaved text, and closes each document of the workspace on the answer No", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const [leaf] = await leafIds(activePage);
    await openInLeaf(activePage, leaf, hiddenPath);
    await activePage
      .locator(`[role="tab"][data-path=${JSON.stringify(hiddenPath)}]`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await openInLeaf(activePage, leaf, genusPath);
    await activePage
      .locator(`[role="tab"][data-path=${JSON.stringify(genusPath)}].active`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await activePage.locator(".cm-content:visible").click();
    await activePage.keyboard.press("ControlOrMeta+End");
    await activePage.keyboard.type(SENTENCE);
    await activePage
      .locator(`[role="tab"][data-path=${JSON.stringify(genusPath)}].modified`)
      .waitFor({ state: "visible", timeout: 30_000 });

    // Cancel: the workspace, its tabs and the unsaved text stay.
    await closeWorkspace(activePage);
    const cancelled = await nativeDialog(PROMPT_TITLE, 30_000);
    screenshots.set("unsaved-prompt.png", await captureWindow(cancelled));
    await pressKey(cancelled, "Escape");
    await delay(1_000);
    assert.equal(await workspaceRow(activePage).count(), 1, "Cancel leaves the workspace");
    assert.deepEqual(await modifiedDocuments(activePage), [genusPath], "Cancel leaves the text");
    assert.deepEqual((await openTabs(activePage)).sort(), [genusPath, hiddenPath].sort());

    // No: the workspace closes with each of its documents, and the file
    // keeps its text.
    await closeWorkspace(activePage);
    const discarded = await nativeDialog(PROMPT_TITLE, 30_000);
    await pressKey(discarded, "Tab");
    await pressKey(discarded, "space");
    await waitUntil(
      async () => (await workspaceRow(activePage).count()) === 0,
      "the workspace to close",
    );
    screenshots.set("workspace-closed.png", await activePage.screenshot());
    assert.equal(await readFile(genusPath, "utf8"), GENUS, "the answer No writes nothing");
    assert.deepEqual(await modifiedDocuments(activePage), [], "no document holds the text");
    await waitUntil(
      async () => (await openTabs(activePage)).length === 0,
      "each document of the workspace to close",
    );
    assert.deepEqual(await nativeDialogs(PROMPT_TITLE, 2_000), [], "one close asks one time");
    // The window shows no document, so the status bar and the Outline show
    // the state of no document.
    assert.equal(
      await activePage.locator('[data-statusbar-item="words"]').count(),
      0,
      "the status bar counts no words of a closed document",
    );
    assert.equal(
      await activePage.locator('[data-section="outline"] .chrome-section-count').count(),
      0,
      "the Outline counts no headings of a closed document",
    );
  });
});
