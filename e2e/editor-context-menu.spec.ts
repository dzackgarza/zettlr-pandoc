/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The context menu of the editor (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An item of the context menu of the editor is the item of
 *                  the application menu that does the same thing (#202): it
 *                  has the label of that item, a table of the context menu is
 *                  the table of Insert → Table, and Copy copies what Edit →
 *                  Copy copies, also the text of a review.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPatch } from "diff";
import type { Browser, Page } from "playwright";
import { sha256Text } from "../source/common/util/sha256";
import {
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  findMenuNode,
  hideDevServerOverlay,
  readAgentApiPort,
  readApplicationMenu,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const REVIEWED = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n\n";
const PROPOSED = REVIEWED.replace("localization", "completion");

/** The items of the Insert and Format menus that the context menu of the editor has. */
const SHARED_ITEMS = [
  "menu.format_bold",
  "menu.format_italic",
  "menu.insert_link",
  "menu.format_bullet_list",
  "menu.format_ordered_list",
  "menu.insert_task_list",
  "menu.format_blockquote",
  "menu.insert_table",
] as const;

const TABLE_ITEM = "menu.insert_table_3x4";

/** The text of the editor of the active document. */
function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = [...document.querySelectorAll(".main-editor-wrapper .cm-content")].find(
      (element) => element.checkVisibility(),
    ) as
      | (HTMLElement & {
          cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } };
        })
      | null;
    const view = content?.cmTile?.root?.view;
    if (view === undefined) {
      throw new Error("the editor exposes no CodeMirror view");
    }
    return view.state.doc.toString();
  });
}

/** The text of the editor once it is not `before`, or after ten seconds. */
async function textOnceChanged(page: Page, before: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await editorText(page);
  while (text === before && Date.now() < deadline) {
    await delay(100);
    text = await editorText(page);
  }
  return text;
}

/**
 * Selects `from`–`to` in the editor, gives it the focus, and answers the
 * point of the window at `at`.
 */
function select(
  page: Page,
  from: number,
  to: number,
  at: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ anchor, head, point }) => {
      const content = [...document.querySelectorAll(".main-editor-wrapper .cm-content")].find(
        (element) => element.checkVisibility(),
      ) as
        | (HTMLElement & {
            cmTile?: {
              root?: {
                view?: {
                  dispatch(spec: { selection: { anchor: number; head: number } }): void;
                  focus(): void;
                  coordsAtPos(
                    pos: number,
                  ): { left: number; right: number; top: number; bottom: number } | null;
                };
              };
            };
          })
        | null;
      const view = content?.cmTile?.root?.view;
      if (view === undefined) {
        throw new Error("the editor exposes no CodeMirror view");
      }
      view.dispatch({ selection: { anchor, head } });
      view.focus();
      const coords = view.coordsAtPos(point);
      if (coords === null) {
        throw new Error(`the editor shows no position ${point}`);
      }
      return { x: coords.left + 2, y: (coords.top + coords.bottom) / 2 };
    },
    { anchor: from, head: to, point: at },
  );
}

/** The text of the clipboard once it is not `before`, or after ten seconds. */
async function clipboardOnceChanged(page: Page, before: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await page.evaluate(() => navigator.clipboard.readText());
  while (text === before && Date.now() < deadline) {
    await delay(100);
    text = await page.evaluate(() => navigator.clipboard.readText());
  }
  return text;
}

/** The labels of the context menu, once it is open, in their order. */
async function shownLabels(page: Page): Promise<string[]> {
  const menu = page.locator(".application-menu").first();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  return await menu.locator(".menu-item .label").allInnerTexts();
}

function clickApplicationMenuItem(page: Page, id: string): Promise<void> {
  return page.evaluate((itemId) => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: itemId });
  }, id);
}

describe("The context menu of the editor (#202)", function () {
  this.timeout(180_000);

  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let configDirectory = "";
  let reviewedPath = "";

  before(async function () {
    const fixture = await createFixture("zettlr-editor-context-menu-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n\n",
      config: { editor: { autoSave: "immediately" }, agentApi: { enabled: true, port: 0 } },
    });
    configDirectory = fixture.configDirectory;
    reviewedPath = path.join(path.dirname(fixture.documentPath), "localization.md");
    await writeFile(reviewedPath, REVIEWED, "utf8");
    ({ browser, appProcess, getOutput } = await attach(configDirectory, [], this.timeout()));
    page = await findEditorPage(browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".main-editor-wrapper .cm-content:visible").waitFor();
  });

  after(async function () {
    // The autosave of the last edit ends before the quit, so the quit asks
    // nothing.
    const unsaved = page?.locator('[role="tab"].modified');
    const deadline = Date.now() + 10_000;
    while (unsaved !== undefined && (await unsaved.count()) > 0 && Date.now() < deadline) {
      await delay(100);
    }
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  it("names its Insert and Format items as the application menu does", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const menu = await readApplicationMenu(activePage);
    const expected = SHARED_ITEMS.map((id) => {
      const label = findMenuNode(menu, id)?.label;
      assert.ok(label !== undefined, `the application menu has the item ${id}`);
      return label;
    });
    const text = await editorText(activePage);
    const word = text.indexOf("lattices") + 2;
    const point = await select(activePage, word, word, word);
    await activePage.mouse.click(point.x, point.y, { button: "right" });
    const labels = await shownLabels(activePage);
    await activePage.keyboard.press("Escape");
    assert.deepEqual(
      expected.filter((label) => !labels.includes(label)),
      [],
      `the context menu shows ${JSON.stringify(labels)}`,
    );
  });

  it("inserts the table of Insert → Table", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // Insert → Table replaces the selected word "Two" with a table.
    const before = await editorText(activePage);
    const two = before.indexOf("Two");
    await select(activePage, two, two + "Two".length, two);
    await clickApplicationMenuItem(activePage, TABLE_ITEM);
    const afterMenu = await textOnceChanged(activePage, before);
    const rest = before.slice(two + "Two".length);
    assert.ok(afterMenu.endsWith(rest), "Insert → Table replaces the selection");
    const table = afterMenu.slice(two, afterMenu.length - rest.length);
    assert.ok(table.includes("|"), `Insert → Table inserts a table: ${JSON.stringify(table)}`);
    const menu = await readApplicationMenu(activePage);
    const tableLabel = findMenuNode(menu, "menu.insert_table")?.label;
    const sizeLabel = findMenuNode(menu, TABLE_ITEM)?.label;
    assert.ok(tableLabel !== undefined && sizeLabel !== undefined, "the menu has the table items");

    // The table of the context menu replaces the selected word "Genus" of the
    // heading; the paragraph after the first table is a row of that table.
    const word = afterMenu.indexOf("Genus");
    const point = await select(activePage, word, word + "Genus".length, word + 2);
    await activePage.mouse.click(point.x, point.y, { button: "right" });
    const shown = await shownLabels(activePage);
    const contextMenu = activePage.locator(".application-menu").first();
    const tableItem = contextMenu
      .locator(".menu-item")
      .filter({ has: activePage.locator(".label", { hasText: new RegExp(`^${tableLabel}$`) }) });
    const tableItems = await tableItem.count();
    if (tableItems !== 1) {
      await activePage.keyboard.press("Escape");
    }
    assert.equal(tableItems, 1, `the context menu has "${tableLabel}": ${JSON.stringify(shown)}`);
    await tableItem.hover();
    await activePage.locator(".application-menu .menu-item .label", { hasText: sizeLabel }).click();
    const afterContext = await textOnceChanged(activePage, afterMenu);
    assert.equal(
      afterContext,
      afterMenu.slice(0, word) + table + afterMenu.slice(word + "Genus".length),
      "the two tables are one table",
    );
  });

  it("copies what Edit → Copy copies in a review", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.evaluate(
      async (pathInPage) =>
        await window.ipc.invoke("documents-provider", {
          command: "open-file",
          payload: { path: pathInPage, newTab: true },
        }),
      reviewedPath,
    );
    await activePage
      .locator(`[role="tab"][data-path=${JSON.stringify(reviewedPath)}].active`)
      .waitFor({ state: "visible", timeout: 30_000 });
    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));
    await api.post("/v1/review-submissions", {
      document: { uri: reviewedPath },
      baseline: { sha256: sha256Text(REVIEWED) },
      clientRequestId: "editor-context-menu-copy",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(reviewedPath, REVIEWED, PROPOSED, "", "", { context: 0 }),
        },
      ],
    });
    await activePage
      .locator("input.suggestion-chunk-comment")
      .waitFor({ state: "visible", timeout: 30_000 });

    const working = await editorText(activePage);
    const from = working.indexOf("Two lattices");
    const to = working.indexOf("\n", from);
    const word = from + "Two la".length;

    await activePage.evaluate(() => navigator.clipboard.writeText("nothing copied"));
    await select(activePage, from, to, word);
    await clickApplicationMenuItem(activePage, "menu.copy");
    const fromMenu = await clipboardOnceChanged(activePage, "nothing copied");
    assert.ok(
      fromMenu.includes("localiza"),
      `Edit → Copy copies the text that the review removes: ${JSON.stringify(fromMenu)}`,
    );

    await activePage.evaluate(() => navigator.clipboard.writeText("nothing copied"));
    const point = await select(activePage, from, to, word);
    await activePage.mouse.click(point.x, point.y, { button: "right" });
    await activePage
      .locator(".application-menu")
      .first()
      .locator(".menu-item")
      .filter({ has: activePage.locator(".label", { hasText: /^Copy$/ }) })
      .click();
    assert.equal(await clipboardOnceChanged(activePage, "nothing copied"), fromMenu);
  });
});
