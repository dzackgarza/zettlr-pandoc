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
import { type AnyMenuItem } from "@common/modules/window-register/application-menu-helper";
import { reportError } from "@common/util/error-reporting";
import { NODES } from "@dzack/pandoc-editor/parser/citation-parser";
import { citationMenu } from "../context-menu/citation-menu";
import { defaultMenu } from "../context-menu/default-menu";
import { linkImageMenu } from "../context-menu/link-image-menu";
import { referenceLabelItems } from "../context-menu/reference-label-item";
import { nodeAtPos } from "../util/node-in-selection";
import { resolveAnnotateSelectionMenuItem } from "./annotate-selection";

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

    const extraItems: AnyMenuItem[] = [];

    // Selection-anchored annotation composer (M6): resolved before the
    // word-selection fallback below can turn an empty selection non-empty.
    const annotateItem = resolveAnnotateSelectionMenuItem(view);
    if (annotateItem !== null) {
      extraItems.unshift(annotateItem);
    }

    // A supported, still-unlabeled reference target (theorem-like div,
    // heading, figure image, listing, display math) offers "Create
    // reference label…" on top of the default menu.
    extraItems.push(...referenceLabelItems(view, pos));

    // If there is nothing selected, select the word at the coords
    const nothingSelected = view.state.selection.ranges.every((x) => x.empty);
    const wordAt = view.state.wordAt(pos);
    if (nothingSelected && wordAt !== null) {
      view.dispatch({ selection: wordAt });
    }

    const node = tree.resolveInner(pos);
    defaultMenu(view, node, coords, extraItems).catch((err) => reportError(err));
    return true;
  },
});
