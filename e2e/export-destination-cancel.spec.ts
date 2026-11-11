/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of an export whose folder dialog is cancelled
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The export destination of the fixture is "ask", so an
 *                  export asks the author for a folder. The author cancels
 *                  the dialog. That is a choice and no failure: the log gets
 *                  no error line, the window shows no error, and nothing is
 *                  exported.
 *
 *                  The folder dialog is a native window: the spec finds and
 *                  answers it on the X display of the run
 *                  (`support/native-dialog.ts`).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
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
  readAppLog,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { captureWindow, nativeDialog, pressKey, searchWindows } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-export-destination-cancel-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const DIALOG_TITLE = "Choose export destination";
const EXPORT_MENU_ITEM = "menu.export";
const LAUNCHER_ROW = "[data-command-launcher] [data-launcher-row]";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The command answers a cancelled dialog at once; a log line of it is written in this time. */
const COMMAND_ENDED_MS = 2_000;

/** The error lines of the log file of the application; the file has the level of each line. */
async function errorLines(fixtureRoot: string): Promise<string[]> {
  return (await readAppLog(fixtureRoot)).split("\n").filter((line) => line.includes("[Error]"));
}

describe("an export whose folder dialog the author cancels", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-export-destination-cancel-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { export: { dir: "ask" } },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
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

  it("writes no error line and exports nothing", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const root = requireInitialized(fixtureRoot, "The fixture must be initialized");
    const filesBefore = await readdir(workspace);
    const errorsBefore = await errorLines(root);

    await editorPage.evaluate((id) => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: id });
    }, EXPORT_MENU_ITEM);
    await editorPage.locator(LAUNCHER_ROW).first().waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("export-profiles.png", await editorPage.screenshot());
    await editorPage.locator(LAUNCHER_ROW).first().click();

    const dialog = await nativeDialog(DIALOG_TITLE, 30_000);
    screenshots.set("folder-dialog.png", await captureWindow(dialog));
    await pressKey(dialog, "Escape");
    const deadline = Date.now() + 30_000;
    while ((await searchWindows(["--name", `^${DIALOG_TITLE}$`])).length > 0) {
      assert.ok(Date.now() < deadline, "the folder dialog closed at the Escape key");
      await delay(250);
    }
    await delay(COMMAND_ENDED_MS);
    screenshots.set("after-cancel.png", await editorPage.screenshot());

    assert.deepEqual(
      await errorLines(root),
      errorsBefore,
      "a cancelled folder dialog is no error of the application",
    );
    assert.equal(await editorPage.locator(ERROR_TOAST).count(), 0, "the window shows no error");
    assert.deepEqual(await readdir(workspace), filesBefore, "nothing was exported");
  });
});
