/**
 * The line of a hover tooltip that names the gestures of a link (#8).
 */

import { EditorView } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";

/** A chip that can be drawn in place of the source of a link. */
export interface LinkChip {
  /** The selector of the element of the widget. */
  selector: string;
  /** The start of the source that the widget replaces. */
  sourceFrom: number;
}

/**
 * Makes the gesture line of a link.
 *
 * @param   {EditorView}  view    The editor of the link
 * @param   {string}      follow  The gesture that follows the link
 * @param   {LinkChip}    chip    The chip of the link
 *
 * @return  {HTMLParagraphElement}  The line. It names the click that shows
 *                                  the source only while the chip is drawn.
 */
export function linkGestureLine(
  view: EditorView,
  follow: string,
  chip: LinkChip,
): HTMLParagraphElement {
  const line = document.createElement("p");
  line.dataset.linkGesture = "true";
  const chipIsDrawn = Array.from(view.contentDOM.querySelectorAll(chip.selector)).some(
    (element) => view.posAtDOM(element) === chip.sourceFrom,
  );
  line.textContent = chipIsDrawn ? `${follow} · ${trans("Click to reveal source")}` : follow;
  return line;
}

export const linkGestureTheme = EditorView.baseTheme({
  "[data-link-gesture]": {
    margin: "6px 0 0 0",
    opacity: "0.7",
    fontSize: "90%",
  },
});
