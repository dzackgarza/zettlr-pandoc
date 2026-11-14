/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Click Listeners
 * CVM-Role:        Plugin
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Follows the link at a place of the document: a plain
 *                  address, a Markdown link, a wikilink, a tag, a
 *                  cross-reference and a footnote. A Mod-click follows the
 *                  link under the pointer (`clickListeners`, for
 *                  `EditorView.domEventHandlers`), and the command
 *                  `followLinkAtCursor` the link at the caret.
 *
 * END HEADER
 */
import { syntaxTree } from "@codemirror/language";
import { Facet } from "@codemirror/state";
import type { DOMEventHandlers, EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import openMarkdownLink from "../util/open-markdown-link";
import {
  followReferenceNavigationIntent,
  resolveReferenceNavigationIntent,
} from "../util/reference-navigation";
import { wikilinkOpener } from "./wikilink-resolutions-field";

/** Opens the tag whose text after `#` is the argument. */
export const tagOpener = Facet.define<(tag: string) => void, ((tag: string) => void) | undefined>({
  combine: (values) => values[0],
});

const WIKILINK_NODES = ["ZknLink", "ZknLinkContent", "ZknLinkTitle", "ZknLinkPipe", "ZknLinkMark"];

/** Opens an address of the document: a wikilink in `[[…]]`, or a Markdown link. */
function openAddress(view: EditorView, url: string): void {
  if (url.startsWith("[[") && url.endsWith("]]")) {
    view.state.facet(wikilinkOpener)?.(url.substring(2, url.length - 2));
  } else {
    openMarkdownLink(url, view);
  }
}

/**
 * Follows the link at a position. An editor without an opener for wikilinks
 * or tags (a table cell) follows no such link, and the link still takes the
 * action.
 *
 * @param   view  The editor
 * @param   pos   The position in the document
 * @param   side  The side of `pos` whose node is read, as for
 *                `SyntaxNode.resolve`: 0 for a node around `pos`, 1 for a
 *                node that can start at it, -1 for a node that can end at it
 *
 * @return        Whether the position has a link
 */
function followLinkAt(view: EditorView, pos: number, side: -1 | 0 | 1): boolean {
  const nodeAt = syntaxTree(view.state).resolve(pos, side);

  // Both plain URLs as well as Zettelkasten links and tags are implemented
  // on the syntax tree.
  if (nodeAt.type.name === "URL") {
    openAddress(view, view.state.sliceDoc(nodeAt.from, nodeAt.to));
    return true;
  }

  if (WIKILINK_NODES.includes(nodeAt.type.name)) {
    // A position on the boundary between two children of the link (the
    // first character of a label whose target is hidden) resolves to the
    // link itself; otherwise the parent is it.
    const linkNode = nodeAt.type.name === "ZknLink" ? nodeAt : nodeAt.parent;
    const contentNode = linkNode?.getChild("ZknLinkContent");
    if (contentNode != null) {
      view.state.facet(wikilinkOpener)?.(view.state.sliceDoc(contentNode.from, contentNode.to));
    }
    return true;
  }

  if (nodeAt.type.name === "ZknTag") {
    const mark = nodeAt.getChild("ZknTagMark");
    view.state.facet(tagOpener)?.(view.state.sliceDoc(mark ? mark.to : nodeAt.from, nodeAt.to));
    return true;
  }

  // Reference occurrences (supported-family Citation clusters) and footnote
  // refs (issue #1 Phase 5): same-file intents select the definition in this
  // view, cross-file intents request the documents provider to open the
  // defining document.
  const intent = resolveReferenceNavigationIntent(view, pos);
  if (intent !== null) {
    followReferenceNavigationIntent(view, intent);
    return true;
  }

  // Lastly, the position may be somewhere in a link. The link description
  // can take various inline elements, so move up the tree to a 'Link'
  // element or to the top.
  let currentNode: SyntaxNode | null = nodeAt;
  while (currentNode !== null && currentNode.name !== "Link") {
    currentNode = currentNode.parent;
  }
  const urlNode = currentNode?.getChild("URL");
  if (urlNode == null) {
    return false;
  }
  openAddress(view, view.state.sliceDoc(urlNode.from, urlNode.to));
  return true;
}

/**
 * Follows the link at the caret: the link around it, else the link that
 * starts at it, else the link that ends at it. Answers false when the caret
 * is on no link, so the key goes to the next binding.
 */
export function followLinkAtCursor(view: EditorView): boolean {
  const { head } = view.state.selection.main;
  return ([0, 1, -1] as const).some((side) => followLinkAt(view, head, side));
}

/**
 * The DOM event listeners that follow the link under the pointer at a
 * Mod-click. An ordinary click reaches no link: it edits.
 */
export function clickListeners<T = unknown>(): DOMEventHandlers<T> {
  return {
    mousedown(event, view) {
      const cmd = event.metaKey && process.platform === "darwin";
      const ctrl = event.ctrlKey && process.platform !== "darwin";
      if (!cmd && !ctrl) {
        return false;
      }

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null || !followLinkAt(view, pos, 0)) {
        return false;
      }
      event.preventDefault();
      return true;
    },
  };
}
