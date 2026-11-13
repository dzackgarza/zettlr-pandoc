/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The list and detail split of the Preferences and Assets windows
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Preferences window and the list tabs of the Assets window
 *                  show a list beside a detail pane. The list starts at a fifth
 *                  of the width. A drag of the handle between the panes
 *                  resizes them, neither pane goes below a fifth, and a
 *                  double-click on the handle gives the list a fifth again
 *                  (#105).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  type RunningApp,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-list-detail-split-e2e-latest");
/** The share of the width that the list has at the start and after a reset. */
const LIST_SHARE = 0.2;
/** The difference of two shares that a pixel of rounding or a border makes. */
const SHARE_TOLERANCE = 0.015;
const WIDTH = 1100;

/** The window whose page has an element, when one has it. */
async function pageWith(browser: Browser, selector: string, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator(selector).count()) > 0) {
          return page;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No window with ${selector} appeared within ${timeoutMs}ms`);
}

/**
 * The share of the width of the split that the panel of the list has. A
 * panel and the split are the elements of reka-ui with `data-panel` and
 * `data-panel-group`.
 */
async function listShare(page: Page, list: string): Promise<number> {
  return await page.evaluate((selector) => {
    const panel = document.querySelector(selector)?.closest("[data-panel]");
    const split = panel?.closest("[data-panel-group]");
    if (panel === null || panel === undefined || split === null || split === undefined) {
      throw new Error(`${selector} is not in a split`);
    }
    return panel.getBoundingClientRect().width / split.getBoundingClientRect().width;
  }, list);
}

/** The centre of the handle after the panel of the list. */
async function handleCentre(page: Page, list: string): Promise<{ x: number; y: number }> {
  return await page.evaluate((selector) => {
    const handle = document.querySelector(selector)?.closest("[data-panel]")?.nextElementSibling;
    if (handle === null || handle === undefined || !handle.hasAttribute("data-resize-handle")) {
      throw new Error(`The panel of ${selector} has no handle after it`);
    }
    const rect = handle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, list);
}

async function dragHandle(page: Page, list: string, offsetX: number): Promise<void> {
  const start = await handleCentre(page, list);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + offsetX, start.y, { steps: 20 });
  await page.mouse.up();
  await delay(200);
}

function assertShare(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) <= SHARE_TOLERANCE,
    `${message}: the list has ${actual.toFixed(3)} of the width, expected ${expected}`,
  );
}

describe("the list and detail split of the Preferences and Assets windows", function () {
  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-list-detail-split-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    const filters = path.join(fixture.configDirectory, "lua-filter");
    await mkdir(filters);
    await writeFile(path.join(filters, "numbering.lua"), "-- Numbers each theorem.\nreturn {}\n");
    app = await attach(fixture.configDirectory, rendererEvents);
    const page = await findEditorPage(app.browser, 60_000);

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: 60_000 });
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
    assertCleanExit(output);
  });

  /** The drags and the reset of one split, with a screenshot of each state. */
  async function exerciseSplit(page: Page, list: string, name: string): Promise<void> {
    await page.locator(list).waitFor({ state: "visible", timeout: 20_000 });
    await delay(300);
    assertShare(await listShare(page, list), LIST_SHARE, "at the start");
    screenshots.set(`${name}-start.png`, await page.screenshot());

    await dragHandle(page, list, 220);
    assertShare(await listShare(page, list), LIST_SHARE + 220 / WIDTH, "after a drag to the right");
    screenshots.set(`${name}-wide.png`, await page.screenshot());

    await dragHandle(page, list, 2 * WIDTH);
    assertShare(await listShare(page, list), 1 - LIST_SHARE, "at the right limit");

    await dragHandle(page, list, -2 * WIDTH);
    assertShare(await listShare(page, list), LIST_SHARE, "at the left limit");

    await dragHandle(page, list, 300);
    const centre = await handleCentre(page, list);
    await page.mouse.dblclick(centre.x, centre.y);
    await delay(200);
    assertShare(await listShare(page, list), LIST_SHARE, "after a double-click on the handle");
  }

  it("resizes the panes of the Preferences window", async function () {
    const running = requireInitialized(app, "the application");
    const editor = await findEditorPage(running.browser, 10_000);
    await editor.evaluate(async () => {
      await window.ipc.invoke("application", { command: "open-preferences" });
    });
    const preferences = await pageWith(running.browser, "#preferences-container-list", 30_000);

    await preferences.setViewportSize({ width: WIDTH, height: 760 });
    await exerciseSplit(preferences, "#preferences-container-list", "preferences");

    // The fieldsets of a group are higher than the window. The wheel over
    // the detail pane scrolls its content, and the list stays in its place.
    const top = async (selector: string): Promise<number> =>
      (await preferences.locator(selector).first().boundingBox())?.y ?? Number.NaN;
    const listBefore = await top("#preferences-container-list");
    const fieldsetBefore = await top("fieldset");
    const detail = await preferences.locator("fieldset").first().boundingBox();
    if (detail === null) {
      throw new Error("The first fieldset of the Preferences window is not shown");
    }
    await preferences.mouse.move(detail.x + detail.width / 2, detail.y + detail.height / 2);
    await preferences.mouse.wheel(0, 600);
    await delay(300);
    const fieldsetAfter = await top("fieldset");
    assert.ok(
      fieldsetAfter < fieldsetBefore - 50,
      `The wheel did not scroll the detail pane: the first fieldset is at ${fieldsetAfter}, before at ${fieldsetBefore}`,
    );
    assert.equal(
      await top("#preferences-container-list"),
      listBefore,
      "The list moved when the detail pane scrolled",
    );
    screenshots.set("preferences-scrolled.png", await preferences.screenshot());
    await preferences.close();
  });

  it("resizes the panes of each list tab of the Assets window", async function () {
    const running = requireInitialized(app, "the application");
    const editor = await findEditorPage(running.browser, 10_000);
    await editor.evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.assets_manager",
      });
    });
    const assets = await pageWith(running.browser, "#tab-filter-control", 30_000);

    await assets.setViewportSize({ width: WIDTH, height: 760 });
    for (const tab of ["tab-filter-control", "tab-export-control"]) {
      await assets.locator(`#${tab}`).click();
      await exerciseSplit(assets, ".asset-container-list", tab);
    }
    await assets.close();
  });
});
