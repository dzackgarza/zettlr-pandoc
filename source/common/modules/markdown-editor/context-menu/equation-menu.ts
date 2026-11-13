/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Equation menu
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Displays a context menu for a given equation
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";
import showPopupMenu, {
  type AnyMenuItem,
} from "@common/modules/window-register/application-menu-helper";
import { reportError } from "@common/util/error-reporting";
import { referenceLabelItems } from "./reference-label-item";

/**
 * Displays a context menu at the given coordinates, for the given equation.
 *
 * @param   {EditorView}                view      The view
 * @param   {string}                    equation  The equation in question
 * @param   {{ x: number, y: number }}  coords    The position
 * @param   {number}                    position  The start of the source of the equation
 */
export function equationMenu(
  view: EditorView,
  equation: string,
  coords: { x: number; y: number },
  position: number,
): void {
  // A display equation is a label target.
  const labelItems = referenceLabelItems(view, position);
  const separator: AnyMenuItem[] = labelItems.length > 0 ? [{ type: "separator" }] : [];
  const tpl: AnyMenuItem[] = [
    ...labelItems,
    ...separator,
    {
      label: trans("Copy equation code"),
      type: "normal",
      action() {
        navigator.clipboard.writeText(equation).catch((err) => reportError(err));
      },
    },
  ];

  showPopupMenu(coords, tpl);
}
