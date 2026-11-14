/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of Previous file and Next file from a window that is no main window
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The keys of File ▸ Previous file and File ▸ Next file go
 *                  through the application menu. The author presses them in
 *                  the Preferences window, and the main window that the
 *                  author used last goes back and forward in its history
 *                  (#57). The keys are keys of the X display of the run
 *                  (xdotool): a key event of the page does not run a menu
 *                  accelerator. The spec runs on the display of the run
 *                  only (AGENTS.md §13).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
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
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { pressKey, windowOfPage } from "./support/native-dialog";
import { leafIds, openInLeaf } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-menu-navigation-auxiliary-e2e-latest");

/** The keys of the registered commands (`command-registry.ts`) on Linux. */
const PREVIOUS_FILE = "ctrl+alt+minus";
const NEXT_FILE = "ctrl+shift+minus";

/** The Preferences window, when it is open. */
function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

/** The path of the active tab of the main window. */
async function activePath(page: Page): Promise<string> {
  const value = await page.locator('div[role="tab"].active').getAttribute("data-path");
  assert.ok(value !== null, "the active tab names its document");
  return value;
}

/** Waits until the active tab of the main window shows `expected`. */
async function waitForActive(page: Page, expected: string, cause: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let current = await activePath(page);
  while (current !== expected) {
    assert.ok(Date.now() < deadline, `${cause}: the active tab is ${current}, not ${expected}`);
    await delay(100);
    current = await activePath(page);
  }
}

describe("assembled app: Previous file and Next file from the Preferences window (#57)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let first = "";
  let second = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-menu-navigation-auxiliary-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    first = fixture.documentPath;
    second = path.join(path.dirname(first), "spinor.md");
    await writeFile(second, "# Spinor\n\nThe spinor norm of a reflection.\n", "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
  });

  after(async function () {
    // A failed step leaves the Preferences window open, and the application
    // does not quit while a window stays open.
    if (browser !== undefined) {
      await preferencesPage(browser)?.close();
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

  it("moves the main window back and forward", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");
    // The author goes from one document to the other and back: the pane has
    // the history genus.md, spinor.md.
    const [leaf] = await leafIds(editorPage);
    await openInLeaf(editorPage, leaf, second);
    await waitForActive(editorPage, second, "the open of the second document");
    await openInLeaf(editorPage, leaf, first);
    await waitForActive(editorPage, first, "the open of the first document");
    await openInLeaf(editorPage, leaf, second);
    await waitForActive(editorPage, second, "the second open of the second document");

    // The keys go back and forward in the pane that the author used last:
    // the author clicks into it.
    await editorPage.locator(".cm-content:visible").first().click();
    const mainWindow = await windowOfPage(editorPage);
    await pressKey(mainWindow, PREVIOUS_FILE);
    await waitForActive(editorPage, first, "Previous file in the main window");
    await pressKey(mainWindow, NEXT_FILE);
    await waitForActive(editorPage, second, "Next file in the main window");

    await editorPage.evaluate(async () => {
      await window.ipc.invoke("application", { command: "open-preferences" });
    });
    const deadline = Date.now() + 20_000;
    let preferences = preferencesPage(running);
    while (preferences === undefined) {
      assert.ok(Date.now() < deadline, "the Preferences window opens");
      await delay(100);
      preferences = preferencesPage(running);
    }
    await preferences.waitForLoadState("load");
    await preferences.locator("body").waitFor({ state: "visible" });
    const preferencesWindow = await windowOfPage(preferences);

    await pressKey(preferencesWindow, PREVIOUS_FILE);
    await waitForActive(editorPage, first, "Previous file in the Preferences window");
    screenshots.set("main-after-previous.png", await editorPage.screenshot());
    await pressKey(preferencesWindow, NEXT_FILE);
    await waitForActive(editorPage, second, "Next file in the Preferences window");
  });
});
