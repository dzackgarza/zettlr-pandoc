/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        onNameFieldBlur
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Decides whether the blur of a name field of the file
 *                  manager (rename, new file, new folder) is the author
 *                  leaving the field.
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import { nextTick } from "vue";

let pointerDown = false;
// A pointer press moves the focus in the default action of its mousedown,
// in the same task: the flag holds for that task only.
document.addEventListener(
  "pointerdown",
  () => {
    pointerDown = true;
    setTimeout(() => {
      pointerDown = false;
    }, 0);
  },
  true,
);

/**
 * Close a name field when the author leaves it, and keep it otherwise.
 *
 * The author leaves a field by a pointer press or by a move of the focus to
 * another element. A field whose row Vue moves (a new row, a new sort) loses
 * the focus to the body by the focus fixup rule of HTML, without either: the
 * field takes the focus again after the patch. A field of a window that
 * loses the focus keeps it; the window gives it back.
 *
 * @param  event  The blur event of the field
 * @param  close  Closes the field
 */
export function onNameFieldBlur(event: FocusEvent, close: () => void): void {
  const field = event.target;
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("A name field is an input element");
  }
  if (event.relatedTarget !== null || pointerDown) {
    close();
    return;
  }
  if (!document.hasFocus()) {
    return;
  }
  nextTick(() => {
    if (field.isConnected && document.activeElement === document.body) {
      field.focus();
    }
  }).catch((err) => reportError(err));
}
