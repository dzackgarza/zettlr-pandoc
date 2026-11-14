/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Distraction-free mode across a restart (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Distraction-free mode is a state of one window. The
 *                  saved settings of the panes are the arrangement of the
 *                  author. The spec enters the mode, quits, starts the app
 *                  again, and asserts that both panes are as before the
 *                  mode. It also asserts that a command that shows a pane
 *                  ends the mode (#204).
 *
 * END HEADER
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
  createWorkspaceFixture,
  findEditorPage,
  preserveArtifacts,
  REPO_ROOT,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-distraction-free-restart-e2e-latest");

const NAVIGATION_HANDLE = '[data-pane-handle="navigation-sidebar"]';
const ANNOTATION_HANDLE = '[data-pane-handle="annotation-panel"]';

async function clickMenuItem(page: Page, id: string): Promise<void> {
  await page.evaluate((itemId) => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: itemId });
  }, id);
}

/** Whether each pane of the window is shown: its handle is not collapsed. */
async function panesShown(page: Page): Promise<{ navigation: boolean; annotations: boolean }> {
  const shown = async (handle: string): Promise<boolean> =>
    !(await page.locator(handle).evaluate((element) => element.classList.contains("collapsed")));
  return {
    navigation: await shown(NAVIGATION_HANDLE),
    annotations: await shown(ANNOTATION_HANDLE),
  };
}

async function waitForPanes(
  page: Page,
  expected: { navigation: boolean; annotations: boolean },
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (JSON.stringify(await panesShown(page)) === JSON.stringify(expected)) {
      return;
    }
    await page.waitForTimeout(100);
  }
  assert.deepEqual(await panesShown(page), expected, what);
  // A screenshot shows the end state of the slide (`paneSlide`), not a frame
  // of it: the slide starts after the handles change, and at its end each
  // pane has the width of its state.
  await page.waitForFunction((shown) => {
    const width = (pane: string): number =>
      document.querySelector(`.main-pane[data-pane="${pane}"]`)?.getBoundingClientRect().width ??
      Number.NaN;
    return (
      document.querySelector(".main-panes.animating") === null &&
      width("navigation-sidebar") > 0 === shown.navigation &&
      width("annotation-panel") > 0 === shown.annotations
    );
  }, expected);
}

describe("assembled app: distraction-free mode across a restart", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory: string | undefined;
  let getOutput: () => string = () => "";
  const outputs: string[] = [];
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  async function start(timeoutMs: number): Promise<Page> {
    const app = await attach(
      requireInitialized(configDirectory, "config directory"),
      rendererEvents,
    );
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    const page = await findEditorPage(browser, timeoutMs);

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: timeoutMs });
    await page.setViewportSize({ width: 1400, height: 900 });
    return page;
  }

  async function stop(): Promise<void> {
    await shutdown(browser, appProcess);
    outputs.push(getOutput());
    browser = undefined;
    appProcess = undefined;
    getOutput = () => "";
  }

  before(async function () {
    const fixture = await createWorkspaceFixture("zettlr-distraction-free-restart-e2e-", {
      workspaceSource: path.join(REPO_ROOT, "test", "fixtures", "quarto-book"),
      activeDocument: path.join("foundations", "forms.md"),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
  });

  after(async function () {
    await stop();
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      outputs.join("\n"),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    for (const output of outputs) {
      assertCleanExit(output);
    }
  });

  it("starts with the panes the author had before a quit in the mode", async function () {
    let page = await start(this.timeout());
    await waitForPanes(page, { navigation: true, annotations: true }, "both panes at the start");

    await page.locator(".cm-content").click();
    await clickMenuItem(page, "menu.toggle_distraction_free");
    await waitForPanes(page, { navigation: false, annotations: false }, "no pane in the mode");
    screenshots.set("distraction-free.png", await page.screenshot());
    await stop();

    const saved = JSON.parse(
      await readFile(
        path.join(requireInitialized(configDirectory, "config directory"), "config.json"),
        "utf8",
      ),
    ) as { window: { fileManagerVisible: boolean; sidebarVisible: boolean } };
    assert.deepEqual(
      { navigation: saved.window.fileManagerVisible, annotations: saved.window.sidebarVisible },
      { navigation: true, annotations: true },
      "the saved settings hold the panes of the author, not the mode",
    );

    page = await start(this.timeout());
    await waitForPanes(page, { navigation: true, annotations: true }, "both panes after a restart");
    screenshots.set("after-restart.png", await page.screenshot());
  });

  it("ends the mode when a command shows a pane", async function () {
    // The first case leaves the app running; after its failure the app is stopped.
    const page =
      browser === undefined
        ? await start(this.timeout())
        : await findEditorPage(browser, this.timeout());
    await page.locator(".cm-content").click();
    await clickMenuItem(page, "menu.toggle_distraction_free");
    await waitForPanes(page, { navigation: false, annotations: false }, "no pane in the mode");

    await clickMenuItem(page, "menu.toggle_navigation_sidebar");
    await waitForPanes(
      page,
      { navigation: true, annotations: true },
      "a shown pane ends the mode, and the other pane is as before the mode",
    );
  });
});
