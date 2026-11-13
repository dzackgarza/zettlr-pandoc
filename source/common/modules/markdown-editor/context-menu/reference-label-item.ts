/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        referenceLabelItems
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The "Create reference label…" item of each context menu
 *                  of a label target: the text of the editor, a drawn
 *                  figure, a drawn equation.
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";
import { type AnyMenuItem } from "@common/modules/window-register/application-menu-helper";
import {
  requestCreateReferenceLabel,
  resolveCreateReferenceLabelRequest,
} from "../plugins/create-reference-label";

/**
 * The item that opens the label dialog for the target at the position: one
 * item for a target without a label, none else.
 *
 * @param   {EditorView}     view  The editor view
 * @param   {number}         pos   The position the author points at
 *
 * @return  {AnyMenuItem[]}        The item, or no item
 */
export function referenceLabelItems(view: EditorView, pos: number): AnyMenuItem[] {
  if (resolveCreateReferenceLabelRequest(view, pos) === null) {
    return [];
  }
  return [
    {
      label: trans("Create reference label…"),
      type: "normal",
      action() {
        requestCreateReferenceLabel(view, pos);
      },
    },
  ];
}
