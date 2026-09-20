/**
 * One syntax-tree traversal per EditorView/state/visible-range set.
 *
 * CodeMirror fires every viewport-sensitive plugin in the same synchronous
 * scroll catch-up update. Walking the same Lezer tree independently in each
 * renderer makes that critical path scale with the number of renderers rather
 * than the amount of visible syntax. Cache the pre-order node stream once and
 * let each consumer apply its own filtering semantics over it.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";

interface VisibleSyntaxCacheEntry {
  state: EditorState;
  tree: Tree;
  rangesKey: string;
  groups: ReadonlyArray<readonly SyntaxNode[]>;
  nodes: readonly SyntaxNode[];
}

const visibleSyntaxCache = new WeakMap<EditorView, VisibleSyntaxCacheEntry>();

function rangesKey(view: EditorView): string {
  return view.visibleRanges.map(({ from, to }) => `${from}:${to}`).join("|");
}

export function visibleSyntaxNodes(view: EditorView): readonly SyntaxNodeRef[] {
  const tree = syntaxTree(view.state);
  const key = rangesKey(view);
  const cached = visibleSyntaxCache.get(view);
  if (cached?.state === view.state && cached.tree === tree && cached.rangesKey === key) {
    return cached.nodes;
  }

  const groups: SyntaxNode[][] = [];
  for (const { from, to } of view.visibleRanges) {
    const group: SyntaxNode[] = [];
    tree.iterate({
      from,
      to,
      enter(node) {
        // Tree.iterate deliberately passes one mutable TreeCursor through the
        // whole walk. Keeping that SyntaxNodeRef would therefore make every
        // cached entry alias the cursor's final position. Lezer explicitly
        // documents `.node` as the stable snapshot accessor; cache that.
        //
        // Reference implementation/API contract:
        // @lezer/common SyntaxNodeRef.node — "Retrieve a stable syntax node at
        // this position" (the adjacent docs warn that SyntaxNodeRef itself is
        // not guaranteed to stay stable).
        group.push(node.node);
      },
    });
    groups.push(group);
  }
  const nodes = groups.flat();

  visibleSyntaxCache.set(view, {
    state: view.state,
    tree,
    rangesKey: key,
    groups,
    nodes,
  });
  return nodes;
}

/**
 * Visit the cached pre-order stream with Lezer's `enter` convention: returning
 * false skips descendants of the current node. This keeps renderer behavior
 * identical to `Tree.iterate({ enter })` without re-walking the tree.
 */
export function visitVisibleSyntaxNodes(
  view: EditorView,
  enter: (node: SyntaxNodeRef) => false | void,
): void {
  // Populate/refresh the cache once; keep range groups so `enter: false`
  // suppression restarts exactly where a separate Tree.iterate call would.
  visibleSyntaxNodes(view);
  const cached = visibleSyntaxCache.get(view);
  if (cached === undefined) {
    return;
  }
  visitSyntaxNodeGroups(cached.groups, enter);
}

export function visitSyntaxNodeGroups<T extends { from: number; to: number }>(
  groups: ReadonlyArray<readonly T[]>,
  enter: (node: T) => false | void,
): void {
  for (const group of groups) {
    let skipUntil = -1;
    for (const node of group) {
      if (node.from < skipUntil) {
        continue;
      }
      skipUntil = -1;
      if (enter(node) === false) {
        skipUntil = node.to;
      }
    }
  }
}
