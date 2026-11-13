/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        "Close all tabs" of the tab context menu E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Close all tabs" in the context menu of a tab and in the
 *                  Window menu are one action (#202): each tab of the pane
 *                  closes, a pinned tab too, and the item is available on a
 *                  pinned tab.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { leafIds, openInLeaf } from "./support/panes";

/** The paths of the tabs of every pane of the window. */
async function openTabs(page: Page): Promise<string[]> {
  return await page.locator('[role="tab"][data-path]').evaluateAll((tabs) =>
    tabs.map((tab) => {
      const tabPath = tab.getAttribute("data-path");
      if (tabPath === null) {
        throw new Error("A tab of the selector [data-path] has no data-path.");
      }
      return tabPath;
    }),
  );
}

function tab(page: Page, documentPath: string) {
  return page.locator(`[role="tab"][data-path=${JSON.stringify(documentPath)}]`);
}

function closeAllItem(page: Page) {
  return page.locator(".application-menu .menu-item", { hasText: "Close all tabs" }).last();
}

describe("Close all tabs from the context menu of a tab (#202)", function () {
  this.timeout(120_000);

  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let genus = "";
  let lemma = "";
  let form = "";

  before(async function () {
    const fixture = await createFixture("zettlr-tab-close-all-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
    });
    genus = fixture.documentPath;
    lemma = path.join(path.dirname(genus), "lemma.md");
    form = path.join(path.dirname(genus), "form.md");
    await writeFile(lemma, "# Lemma\n\nA unimodular lattice is its own dual.\n");
    await writeFile(form, "# Form\n\nThe discriminant form of an even lattice.\n");
    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, []));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  it("closes each tab of the pane, a pinned tab too", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const [leaf] = await leafIds(activePage);
    for (const documentPath of [genus, lemma, form]) {
      await openInLeaf(activePage, leaf, documentPath);
    }
    await activePage.evaluate(
      async ([leafId, pinnedPath]) => {
        const windowId = new URLSearchParams(location.search).get("window_id");
        if (windowId === null) {
          throw new Error("The main window carries no window_id");
        }
        await window.ipc.invoke("documents-provider", {
          command: "set-pinned",
          payload: { windowId, leafId, path: pinnedPath, pinned: true },
        });
      },
      [leaf, genus],
    );
    await tab(activePage, genus).waitFor({ state: "visible" });
    assert.deepEqual((await openTabs(activePage)).sort(), [form, genus, lemma].sort());

    await tab(activePage, genus).click({ button: "right" });
    await closeAllItem(activePage).waitFor({ state: "visible" });
    assert.equal(
      await closeAllItem(activePage).evaluate((item) => item.classList.contains("disabled")),
      false,
      "the item is available on a pinned tab",
    );
    await activePage.keyboard.press("Escape");

    await tab(activePage, lemma).click({ button: "right" });
    await closeAllItem(activePage).click();
    const deadline = Date.now() + 10_000;
    while ((await openTabs(activePage)).length > 0 && Date.now() < deadline) {
      await delay(100);
    }
    assert.deepEqual(await openTabs(activePage), [], "no tab of the pane stays open");
  });
});
