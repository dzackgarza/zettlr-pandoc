/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The Preferences window at its default size (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Preferences window opens at 700 × 800 px when no
 *                  size of the author is saved. Each group fits that width:
 *                  no control ends past the right edge of the window, so no
 *                  group needs a horizontal scroll and no button is cut.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { PreferencesGroups } from "../source/types/common/preferences";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-preferences-default-width-e2e-latest");

/** The Preferences window, when it is open. */
function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

/**
 * The controls of the shown group that end past the visible right edge: of
 * the window, or of a pane that scrolls them. A scroll bar covers the right
 * end of a control that ends under it.
 */
async function cutElements(preferences: Page): Promise<string[]> {
  return await preferences.evaluate(() => {
    // A function in the page declares no named function (AGENTS.md §13).
    const cut: string[] = [];
    for (const element of Array.from(
      document.querySelectorAll("button, input, select, textarea, label"),
    )) {
      const box = element.getBoundingClientRect();
      let visibleRight = document.documentElement.clientWidth;
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== "visible") {
          const parentBox = parent.getBoundingClientRect();
          visibleRight = Math.min(
            visibleRight,
            parentBox.left + parent.clientLeft + parent.clientWidth,
          );
        }
      }
      if (box.width > 0 && box.right > visibleRight + 0.5) {
        cut.push(
          `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 30)}" ends at ${Math.round(box.right)} px, the visible edge at ${Math.round(visibleRight)} px`,
        );
      }
    }
    for (const pane of Array.from(document.querySelectorAll("*"))) {
      const overflow = getComputedStyle(pane).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && pane.scrollWidth > pane.clientWidth) {
        cut.push(`a pane scrolls ${pane.scrollWidth - pane.clientWidth} px to the side`);
      }
    }
    return cut;
  });
}

describe("the Preferences window at its default size", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-preferences-default-width-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
  });

  after(async function () {
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

  it("shows each group within the width of the window", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");
    const cut = new Map<string, string[]>();
    let shownGroup = "";
    for (const [name, group] of Object.entries(PreferencesGroups)) {
      if (typeof group !== "number") {
        continue;
      }
      await editorPage.evaluate(
        async (target) => {
          await window.ipc.invoke("application", { command: "open-preferences", payload: target });
        },
        { group },
      );
      const deadline = Date.now() + 20_000;
      let preferences = preferencesPage(running);
      while (preferences === undefined) {
        assert.ok(Date.now() < deadline, "the Preferences window opens");
        await delay(100);
        preferences = preferencesPage(running);
      }
      // The list of groups selects the group that the window shows.
      const selected = preferences.locator(".selectable-list-container .selected .display-text");
      await preferences.waitForFunction((previous) => {
        const text =
          document.querySelector(".selectable-list-container .selected .display-text")
            ?.textContent ?? "";
        return text !== "" && text !== previous;
      }, shownGroup);
      shownGroup = await selected.innerText();
      assert.deepEqual(
        await preferences.evaluate(() => [window.innerWidth, window.innerHeight]),
        [700, 800],
        "the window has its default size",
      );
      // A control of the group fades in: the screenshot waits for its end.
      await preferences.waitForFunction(() =>
        document.getAnimations().every((animation) => animation.playState !== "running"),
      );
      screenshots.set(`group-${name}.png`, await preferences.screenshot({ fullPage: true }));
      // A page screenshot shows only the top of the pane that scrolls.
      const tables = preferences.locator("div.table-view");
      for (let index = 0; index < (await tables.count()); index++) {
        screenshots.set(`group-${name}-table-${index}.png`, await tables.nth(index).screenshot());
      }
      const elements = await cutElements(preferences);
      if (elements.length > 0) {
        cut.set(name, elements);
      }
    }
    assert.deepEqual(Object.fromEntries(cut), {}, "no group has a control past the window edge");
  });
});
