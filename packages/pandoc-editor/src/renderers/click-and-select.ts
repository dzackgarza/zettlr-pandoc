/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Click and Select Utility
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This function can be used by renderers to enable an easy way
 *                  to select the source code behind rendered widgets.
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import { selectRenderedSourceRange } from "./reveal-rendered-source";

/**
 * A helper function that returns the `mousedown` listener of a widget that
 * selects the exact source range owned by the rendered replacement widget. The
 * base renderer stamps the length of that range onto the widget DOM when it
 * creates the Decoration.replace range.
 *
 * The listener acts on the mousedown of the primary button, not on the click:
 * the default mousedown moves the selection to the edge of the widget, the
 * renderer then shows the source of a widget that the selection touches, and
 * the click arrives at the source text, not at the widget (#131).
 *
 * @param   {EditorView}  view   The editor view
 *
 * @return  {Function}           The listener of the mousedown of the widget
 */
export default function clickAndSelect(view: EditorView): (event: MouseEvent) => void {
  return function (event: MouseEvent) {
    const { target } = event;
    if (event.button !== 0 || !(target instanceof Element)) {
      return;
    }

    const sourceOwner = target.closest<HTMLElement>("[data-preview-source-length]");
    if (sourceOwner === null) {
      return;
    }

    // The widget holds the length of its source, not its position: the view
    // knows where the widget is now, after every edit before it.
    const from = view.posAtDOM(sourceOwner);
    selectRenderedSourceRange(
      view,
      event,
      from,
      from + Number(sourceOwner.dataset.previewSourceLength),
    );
  };
}
