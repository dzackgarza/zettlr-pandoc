/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The zoom of the editor font (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     With `system.zoomBehavior` = `editor`, the View menu
 *                  items "Zoom in" and "Zoom out" change the saved setting
 *                  `editor.fontSize` by one pixel. The setting has the range
 *                  of its rule; a zoom out at the lower end leaves the size
 *                  as it is, and the editor shows text of that size (#204).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  type RunningApp,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-editor-font-zoom-e2e-latest");

async function clickMenuItem(page: Page, id: string): Promise<void> {
  await page.evaluate((itemId) => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: itemId });
  }, id);
}

/** The setting as the main process holds it. */
async function savedFontSize(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      window.ipc.sendSync("config-provider", {
        command: "get-config",
        payload: { key: "editor.fontSize" },
      }) as number,
  );
}

/** The font size of the text of the editor, in pixels. */
async function shownFontSize(page: Page): Promise<number> {
  return await page
    .locator(".main-editor-wrapper")
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
}

describe("assembled app: the zoom of the editor font", function () {
  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let page: Page | undefined;
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-editor-font-zoom-e2e-", {
      documentName: "lattices.md",
      documentContents: "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n",
      config: {
        system: { checkForUpdates: false, zoomBehavior: "editor" },
        editor: { fontSize: 8 },
      },
    });
    fixtureRoot = fixture.root;
    app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    page = await findEditorPage(app.browser, 60_000);
    await hideDevServerOverlay(page);
  });

  after(async function () {
    let output = "";
    if (app !== undefined) {
      await shutdown(app.browser, app.appProcess);
      output = app.getOutput();
    }
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixtureRoot, output, rendererEvents, screenshots);
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(output);
  });

  it("stops a zoom out at the smallest font size", async function () {
    const editor = requireInitialized(page, "editor page");
    for (let step = 0; step < 4; step++) {
      await clickMenuItem(editor, "menu.zoom_out");
    }
    // A zoom in after the zoom outs: the menu still answers at the bound.
    await clickMenuItem(editor, "menu.zoom_in");
    // The main process takes the messages of one window in their order, so
    // the read below follows the five clicks. The editor draws the size of
    // the last change.
    await editor.waitForTimeout(1_000);
    screenshots.set("editor-font-zoom.png", await editor.screenshot());
    assert.deepEqual(
      { saved: await savedFontSize(editor), shown: await shownFontSize(editor) },
      { saved: 7, shown: 7 },
      "four zoom outs from 8 px end at 6 px, and the zoom in gives 7 px",
    );
  });
});
