/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        WebGL context of the task indicator E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The status bar shows the task indicator while the task
 *                  list holds a task, so each background task of a session
 *                  makes a new indicator. A window has a limit of WebGL
 *                  contexts ("Too many active WebGL contexts"): an indicator
 *                  that leaves the status bar gives its context back.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const TASKS = '#main-statusbar [data-statusbar-item="tasks"]';

describe("WebGL context of the task indicator", function () {
  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;

  before(async function () {
    const fixture = await createFixture("zettlr-task-indicator-webgl-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
    });
    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, [], {
      softwareWebGL: true,
    }));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  it("an indicator that leaves the status bar loses its context", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(".editor-pane .cm-content").first().click();
    // A Flowmark format is a task of the list while it runs.
    await activePage.keyboard.press("Control+Alt+l");
    const canvas = await activePage
      .locator(`${TASKS} button.iris-indicator canvas`)
      .elementHandle({ timeout: 30_000 });
    assert.ok(canvas !== null, "the status bar shows the WebGL indicator");
    // A canvas gives the context that it has for a second request.
    assert.equal(
      await canvas.evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("webgl2");
        return context === null ? null : context.isContextLost();
      }),
      false,
      "the shown indicator draws with a WebGL context",
    );

    await activePage
      .locator('#main-statusbar [data-statusbar-item="running-task"]')
      .waitFor({ state: "detached", timeout: 60_000 });
    // A task that failed stays in the list until the author clears it.
    if ((await activePage.locator(TASKS).count()) > 0) {
      await activePage.locator(`${TASKS} button.iris-indicator`).click();
      await activePage.getByText("Clear finished tasks").click();
    }
    await activePage.locator(TASKS).waitFor({ state: "detached", timeout: 60_000 });

    assert.equal(
      await canvas.evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("webgl2");
        return context === null ? null : context.isContextLost();
      }),
      true,
      "the context of the removed indicator is lost",
    );
  });
});
