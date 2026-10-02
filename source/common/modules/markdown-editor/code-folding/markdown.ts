/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown code folding service
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Folding service that can fold Markdown files.
 *
 * END HEADER
 */

import { foldService, syntaxTree } from "@codemirror/language";
import { type Tree } from "@lezer/common";
import { markdownHeadingLevel } from "../util/heading-level";

interface TopLevelHeading {
  from: number;
  level: number;
}

// The fold gutter asks for the fold range of each heading line in the viewport
// after each document change. One tree has one list of headings, so the list
// is made once and lives as long as its tree.
const headingsOfTree = new WeakMap<Tree, TopLevelHeading[]>();

function topLevelHeadings(tree: Tree): TopLevelHeading[] {
  const known = headingsOfTree.get(tree);
  if (known !== undefined) {
    return known;
  }
  const headings: TopLevelHeading[] = [];
  let sibling = tree.topNode.firstChild;
  while (sibling !== null) {
    const level = markdownHeadingLevel(sibling);
    if (level !== null) {
      headings.push({ from: sibling.from, level });
    }
    sibling = sibling.nextSibling;
  }
  headingsOfTree.set(tree, headings);
  return headings;
}

// Code folding for Markdown documents, as the regular code folding service
// doesn't completely do what we need it to. NOTE: Most folding is already
// provided by the corresponding mode. Here we only add more folding which that
// mode doesn't already provide out of the box.
export const markdownFolding = foldService.of((state, lineStart, _lineEnd) => {
  let { node } = syntaxTree(state).cursorAt(lineStart, 1);
  if (node.from < lineStart) {
    return null; // The node doesn't start on this line
  } else if (
    node.type.name === "ATXHeading" ||
    node.type.name.startsWith("SetextHeading") ||
    node.type.name === "HeaderMark"
  ) {
    if (node.type.name === "HeaderMark" && node.parent !== null) {
      node = node.parent;
    }

    // We need headings to be foldable. We basically just have to search for
    // the next heading of equal level (or below)
    const level = markdownHeadingLevel(node);
    if (level === null) {
      return null;
    }
    const end = node.to;
    const next = topLevelHeadings(syntaxTree(state)).find((h) => h.from > end && h.level <= level);

    if (next === undefined) {
      return { from: node.to, to: state.doc.length };
    } else {
      return { from: node.to, to: next.from - 1 };
    }
  } else {
    // Nothing to fold
    return null;
  }
});
