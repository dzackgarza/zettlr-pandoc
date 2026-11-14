/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The Project properties window in an assembled-app test
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Finds the page of the Project properties window among the
 *                  windows of the application. The window has the panel of
 *                  the export formats.
 *
 * END HEADER
 */

import type { Browser, Page } from "playwright";
import { delay } from "./electron-app";

/** The page of the Project properties window, once one is open. */
export async function findProjectPropertiesPage(
  browser: Browser,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator("#formats-panel").count()) > 0) {
          return page;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No project-properties window appeared within ${timeoutMs}ms`);
}
