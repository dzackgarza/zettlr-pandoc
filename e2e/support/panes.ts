/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Panes of the main window in an assembled-app test
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Reads and changes the panes of the main window through the
 *                  documents provider, as the window does. The code that
 *                  runs in the page declares no named function: the page has
 *                  no helper of the loader that keeps function names.
 *
 * END HEADER
 */

import type { Page } from "playwright";

/** The ids of the panes of the window of the page. */
export async function leafIds(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const windowId = new URLSearchParams(location.search).get("window_id");
    if (windowId === null) {
      throw new Error("The main window carries no window_id");
    }
    const tree = await window.ipc.invoke("documents-provider", {
      command: "retrieve-tab-config",
      payload: { windowId },
    });
    const leaves: string[] = [];
    const stack = [tree];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (node.type === "leaf") {
        leaves.push(node.id);
      } else {
        stack.push(...node.nodes);
      }
    }
    return leaves;
  });
}

/** Opens a document in a new tab of one pane. */
export async function openInLeaf(page: Page, leafId: string, documentPath: string): Promise<void> {
  await page.evaluate(
    async ([leaf, pathInPage]) => {
      const windowId = new URLSearchParams(location.search).get("window_id");
      if (windowId === null) {
        throw new Error("The main window carries no window_id");
      }
      await window.ipc.invoke("documents-provider", {
        command: "open-file",
        payload: { windowId, leafId: leaf, path: pathInPage, newTab: true },
      });
    },
    [leafId, documentPath],
  );
}

/**
 * Splits the single pane of the window, opens a document in the new pane and
 * returns the id of the new pane.
 */
export async function splitAndOpen(page: Page, documentPath: string): Promise<string> {
  const before = await leafIds(page);
  if (before.length !== 1) {
    throw new Error(`Expected a single pane to split, found ${before.length}`);
  }
  await page.evaluate(async (originLeaf) => {
    const windowId = new URLSearchParams(location.search).get("window_id");
    if (windowId === null) {
      throw new Error("The main window carries no window_id");
    }
    // "horizontal" is the direction of two panes side by side.
    await window.ipc.invoke("documents-provider", {
      command: "split-leaf",
      payload: {
        originWindow: windowId,
        originLeaf,
        direction: "horizontal",
        insertion: "after",
      },
    });
  }, before[0]);
  const created = (await leafIds(page)).find((id) => !before.includes(id));
  if (created === undefined) {
    throw new Error("The split produced no new pane");
  }
  await openInLeaf(page, created, documentPath);
  return created;
}
