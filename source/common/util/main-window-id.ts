/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The id of the main window of a renderer
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The window provider puts the id of each main window in
 *                  the URL of its page (`window_id`, create-main-window.ts).
 *                  Code of the main window reads it here. A page without the
 *                  parameter is no main window, and the read throws.
 *
 * END HEADER
 */

/** The id of the main window that shows this page. */
export function mainWindowId(): string {
  const id = new URLSearchParams(window.location.search).get("window_id");
  if (id === null) {
    throw new Error(`The page ${window.location.href} is no main window: its URL has no window_id`);
  }
  return id;
}
