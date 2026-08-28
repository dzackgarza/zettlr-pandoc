/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        defaultContextMenu
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Showws a default context menu that applies for an unspecific
 *                  position within the editor. Widgets may define their own
 *                  context menus as appropriate.
 *
 * END HEADER
 */

import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";
import { type AnyMenuItem } from "@common/modules/window-register/application-menu-helper";
import { citationMenu } from "../context-menu/citation-menu";
import { defaultMenu } from "../context-menu/default-menu";
import { linkImageMenu } from "../context-menu/link-image-menu";
import { NODES } from "../parser/citation-parser";
import { nodeAtPos } from "../util/node-in-selection";
import {
  requestCreateReferenceLabel,
  resolveCreateReferenceLabelRequest,
} from "./create-reference-label";

export const defaultContextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const coords = { x: event.clientX, y: event.clientY };
    // First, determine where we clicked
    const pos = view.posAtCoords(coords);

    if (pos === null) {
      return false; // No context menu to show
    }

    const tree = syntaxTree(view.state);

    const maybeLinkNode = nodeAtPos(pos, tree, ["URL", "Link", "Image", "LinkReference"]);
    if (maybeLinkNode !== null) {
      // We can show a Link/Image context menu!
      linkImageMenu(view, maybeLinkNode, coords);
      return true;
    }

    const citationNode = nodeAtPos(pos, tree, [NODES.CITATION]);

    if (citationNode !== null) {
      // We can show a citation menu
      citationMenu(view, coords, citationNode);
      return true;
    }

    // Node-routed create-label entry (issue #1 Phase 6): a supported,
    // still-unlabeled reference target (theorem-like div, heading, figure
    // image, listing, display math) offers "Create reference label…" on top
    // of the default menu.
    const extraItems: AnyMenuItem[] = [];
    if (resolveCreateReferenceLabelRequest(view, pos) !== null) {
      extraItems.push({
        label: trans("Create reference label…"),
        type: "normal",
        action() {
          requestCreateReferenceLabel(view, pos);
        },
      });
    }

    // If there is nothing selected, select the word at the coords
    const nothingSelected = view.state.selection.ranges.every((x) => x.empty);
    const wordAt = view.state.wordAt(pos);
    if (nothingSelected && wordAt !== null) {
      view.dispatch({ selection: wordAt });
    }

    const node = tree.resolveInner(pos);
    defaultMenu(view, node, coords, extraItems).catch((err) => console.error(err));
    return true;
  },
});
