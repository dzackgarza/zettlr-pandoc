/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer recovery E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Ends and hangs the renderer of the main window of the
 *                  assembled app while a document has unsaved text. The app
 *                  shows a native prompt with the reason; the window that
 *                  the author loads again has the unsaved text, and a close
 *                  of the stopped window goes through the unsaved-changes
 *                  prompt (#196).
 *
 *                  The prompts are native message boxes, not pages: the
 *                  spec finds and answers them with xdotool and captures
 *                  them with ImageMagick on the X display of the run.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  observeRenderer,
  preserveArtifacts,
  readAppLog,
  requestQuit,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { captureWindow, nativeDialogs, pressKey, searchWindows } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-renderer-recovery-e2e-latest");
const DRAFT = "# Orbits\n\n";
const SENTENCE = "The orbit of a point has the index of its stabilizer as its size.";
const STOPPED_TITLE = "Window stopped";
const NOT_RESPONDING_TITLE = "Window not responding";
const QUIT_PROMPT_TITLE = "Unsaved changes";
const HUNG_RENDERER_END =
  /^.*FATAL:content\/child\/child_thread_impl\.cc.*Crashing because hung$/gm;

describe("assembled app: a main window whose renderer exits or hangs", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let devToolsUrl = "";
  let page: Page | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** The page of the main window on a new connection: the old one ended with its renderer. */
  async function connectAgain(): Promise<Page> {
    await browser?.close();
    const connected = await chromium.connectOverCDP(devToolsUrl, { timeout: 20_000 });
    browser = connected;
    for (const context of connected.contexts()) {
      context.pages().forEach((open) => observeRenderer(open, rendererEvents));
    }
    const editorPage = await findEditorPage(connected, 30_000);
    await hideDevServerOverlay(editorPage);
    await editorPage.locator(".cm-content:visible").waitFor({ state: "visible", timeout: 30_000 });
    page = editorPage;
    return editorPage;
  }

  /** Waits until the output of the app has a line of a renderer after the first match of `event`. */
  async function rendererRunsAfter(event: RegExp, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const output = getOutput();
      const found = event.exec(output);
      if (found !== null && output.indexOf("[R] [Main Window", found.index) !== -1) {
        return;
      }
      assert.ok(Date.now() < deadline, `no renderer wrote to the log after ${String(event)}`);
      await delay(250);
    }
  }

  async function rendererCpuTimes(): Promise<Map<number, number>> {
    const session = await requireInitialized(
      browser,
      "The browser must be connected",
    ).newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    await session.detach();
    return new Map(
      processInfo.filter((info) => info.type === "renderer").map((info) => [info.id, info.cpuTime]),
    );
  }

  /**
   * The process id of the renderer of the main window. Chromium keeps a
   * spare renderer beside it: the renderer of the window is the one whose
   * processor time grows while the page computes.
   */
  async function rendererPid(): Promise<number> {
    const shown = requireInitialized(page, "The main window must be loaded");
    const before = await rendererCpuTimes();
    await shown.evaluate(() => {
      const end = performance.now() + 1_000;
      while (performance.now() < end) {
        // The page uses its processor for one second.
      }
    });
    const after = await rendererCpuTimes();
    // A renderer of the first reading only: the page ran before that reading.
    const busy = [...after].filter(([pid, cpuTime]) => {
      const earlier = before.get(pid);
      return earlier !== undefined && cpuTime - earlier > 0.5;
    });
    assert.equal(
      busy.length,
      1,
      `one renderer did the work of the page: ${JSON.stringify([[...before], [...after]])}`,
    );
    return busy[0][0];
  }

  async function assertWindowHasUnsavedText(shown: Page, message: string): Promise<void> {
    await shown
      .locator(`[role="tab"][data-path="${documentPath}"].modified`)
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      (await shown.locator(".cm-content:visible").innerText()).includes(SENTENCE),
      true,
      message,
    );
  }

  before(async function () {
    const fixture = await createFixture("zettlr-renderer-recovery-e2e-", {
      documentName: "orbits.md",
      documentContents: DRAFT,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    devToolsUrl = app.devToolsUrl;
    const editorPage = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(editorPage);
    await editorPage.locator(".cm-content:visible").click();
    await editorPage.keyboard.press("ControlOrMeta+End");
    await editorPage.keyboard.type(SENTENCE);
    await assertWindowHasUnsavedText(editorPage, "the editor has the text of the author");
    page = editorPage;
  });

  after(async function () {
    // The display at the end of the run: a prompt that no case answered is on it.
    screenshots.set("display-at-end.png", await captureWindow("root"));
    await browser?.close();
    browser = undefined;
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
  });

  it("offers to load the window again when its renderer was killed, and the window has the unsaved text", async function () {
    const root = requireInitialized(fixtureRoot, "The fixture must exist");
    process.kill(await rendererPid(), "SIGKILL");
    // A new file in the workspace makes the app broadcast to its windows
    // while this one has no renderer.
    await writeFile(path.join(path.dirname(documentPath), "stabilizers.md"), "# Stabilizers\n");

    const prompts = await nativeDialogs(STOPPED_TITLE, 20_000);
    assert.equal(prompts.length, 1, "the app shows one prompt for the window that stopped");
    screenshots.set("stopped-prompt.png", await captureWindow(prompts[0]));
    // Return activates the default button: load the window again.
    await pressKey(prompts[0], "Return");

    const loaded = await connectAgain();
    await assertWindowHasUnsavedText(
      loaded,
      "the window that was loaded again shows the unsaved text",
    );
    screenshots.set("loaded-again.png", await loaded.screenshot());

    assert.match(
      await readAppLog(root),
      /Renderer process gone: reason=killed exitCode=\d+/,
      "the log has the reason that Electron gave",
    );
    assert.doesNotMatch(
      getOutput(),
      /Render frame was disposed/,
      "the app sent no message to a window without a renderer",
    );
  });

  it("offers to load the window again when its renderer does not respond", async function () {
    const shown = requireInitialized(page, "The main window must be loaded");
    const title = await shown.title();
    await shown.evaluate(() => {
      setTimeout(() => {
        for (;;) {
          // The renderer never returns to its event loop.
        }
      }, 1_500);
    });
    // Chromium reports no hung renderer while a debugger is attached to it.
    await browser?.close();
    browser = undefined;
    await delay(3_000);

    // The hang monitor of Chromium starts at an input event that the
    // renderer does not acknowledge.
    const mainWindows = await searchWindows([
      "--name",
      `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ]);
    assert.equal(mainWindows.length, 1, `one window has the title "${title}"`);
    await pressKey(mainWindows[0], "shift");

    const prompts = await nativeDialogs(NOT_RESPONDING_TITLE, 90_000);
    assert.equal(
      prompts.length,
      1,
      "the app shows one prompt for the window that does not respond",
    );
    screenshots.set("not-responding-prompt.png", await captureWindow(prompts[0]));
    // The default button keeps the window: the mnemonic chooses the load.
    await pressKey(prompts[0], "alt+l");

    // The app ends the renderer that hangs, and the log has the reason. A
    // connection that Playwright made at the moment of that end gave no
    // answer in two runs: the spec connects when the new renderer runs.
    await rendererRunsAfter(/Renderer process gone: reason=crashed exitCode=\d+/, 30_000);
    const loaded = await connectAgain();
    await assertWindowHasUnsavedText(
      loaded,
      "the window that was loaded again shows the unsaved text",
    );
  });

  it("closes a stopped window through the unsaved-changes prompt, and a cancel leaves a window that works", async function () {
    const running = requireInitialized(appProcess, "The app process must be running");
    process.kill(await rendererPid(), "SIGKILL");

    const stopped = await nativeDialogs(STOPPED_TITLE, 20_000);
    assert.equal(stopped.length, 1, "the app shows one prompt for the window that stopped");
    await pressKey(stopped[0], "alt+c");

    // The window is the last one: its close is a quit, and the quit asks
    // about the unsaved text.
    const cancelled = await nativeDialogs(QUIT_PROMPT_TITLE, 20_000);
    assert.equal(
      cancelled.length,
      1,
      "the close of the stopped window asks about the unsaved text",
    );
    screenshots.set("close-asks.png", await captureWindow(cancelled[0]));
    await pressKey(cancelled[0], "Escape");

    const loaded = await connectAgain();
    await assertWindowHasUnsavedText(
      loaded,
      "after the cancel the window works and shows the unsaved text",
    );

    const exited = once(running, "exit");
    await requestQuit(loaded);
    const saving = await nativeDialogs(QUIT_PROMPT_TITLE, 20_000);
    assert.equal(saving.length, 1, "the quit asks about the unsaved text");
    await pressKey(saving[0], "Return");
    const outcome = await Promise.race([exited, delay(30_000).then(() => "still running")]);
    assert.deepEqual(outcome, [0, null], "the answer Save changes ends the app");
    // Chromium writes one FATAL line for the renderer that the app ended in
    // the case above. Each other fatal line is a failure of the app.
    assertCleanExit(getOutput().replace(HUNG_RENDERER_END, ""));
    assert.equal(await readFile(documentPath, "utf8"), `${DRAFT}${SENTENCE}`, "the text is saved");
  });
});
