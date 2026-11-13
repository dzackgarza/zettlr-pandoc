/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        hoverText
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Moves the mouse onto a text of the editor, so that the
 *                  hover tooltips of that text open.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { Page } from "playwright";

/**
 * Moves the mouse onto the second character of the first occurrence of a
 * text in the lines of the editor.
 */
export async function hoverText(page: Page, text: string): Promise<void> {
  const target = page.locator(".cm-content .cm-line", { hasText: text }).first();
  await target.waitFor({ state: "visible", timeout: 20_000 });
  // CodeMirror splits a token over the text nodes of its syntax spans, so
  // the second character of the text is found by its offset in the line.
  const box = await target.evaluate((line, needle) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push(node as Text);
    }
    let remaining =
      nodes
        .map((node) => node.data)
        .join("")
        .indexOf(needle) + 1;
    if (remaining === 0) {
      return null;
    }
    for (const node of nodes) {
      if (remaining < node.data.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, remaining + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      remaining -= node.data.length;
    }
    return null;
  }, text);
  assert.ok(box !== null, `The editor shows the text ${text}`);
  await page.mouse.move(box.x, box.y);
}
