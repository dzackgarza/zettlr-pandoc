import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { Tree, type TreeBuffer } from "@lezer/common";

export interface SourceRange {
  from: number;
  to: number;
}

export interface NodeDecorationSource {
  decorate: (state: EditorState, from: number, to: number) => Array<Range<Decoration>>;
  inputsChanged: (before: EditorState, after: EditorState) => boolean;
  changedReach: (transaction: Transaction) => readonly SourceRange[];
}

interface TopLevelBlocks {
  nodes: Array<Tree | TreeBuffer>;
  from: number[];
  index: Map<Tree | TreeBuffer, number>;
}

interface NodeDecorations {
  decorations: DecorationSet;
  tree: Tree;
  blocks: TopLevelBlocks;
}

function collectBlocks(tree: Tree, offset: number, blocks: TopLevelBlocks): void {
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    const from = offset + tree.positions[i];
    if (child instanceof Tree && child.type.isAnonymous) {
      collectBlocks(child, from, blocks);
    } else {
      blocks.index.set(child, blocks.nodes.length);
      blocks.nodes.push(child);
      blocks.from.push(from);
    }
  }
}

const blocksOfTree = new WeakMap<Tree, TopLevelBlocks>();

function topLevelBlocks(tree: Tree): TopLevelBlocks {
  const known = blocksOfTree.get(tree);
  if (known !== undefined) {
    return known;
  }
  const blocks: TopLevelBlocks = { nodes: [], from: [], index: new Map() };
  collectBlocks(tree, 0, blocks);
  blocksOfTree.set(tree, blocks);
  return blocks;
}

function blocksAfterShortTree(
  tree: Tree,
  known: TopLevelBlocks,
  transaction: Transaction,
  regions: readonly SourceRange[],
): TopLevelBlocks {
  const parsed = topLevelBlocks(tree);
  const blocks: TopLevelBlocks = {
    nodes: [...parsed.nodes],
    from: [...parsed.from],
    index: new Map(parsed.index),
  };
  for (let i = 0; i < known.nodes.length; i++) {
    const node = known.nodes[i];
    const from = known.from[i];
    const to = from + node.length;
    if (transaction.docChanged && transaction.changes.touchesRange(from, to) !== false) {
      continue;
    }
    const mapped = transaction.changes.mapPos(from);
    const end = mapped + node.length;
    const redrawn = regions.some((region) => mapped <= region.to && end >= region.from);
    if (mapped < tree.length || redrawn || blocks.index.has(node)) {
      continue;
    }
    blocks.index.set(node, blocks.nodes.length);
    blocks.nodes.push(node);
    blocks.from.push(mapped);
  }
  return blocks;
}

function changedRanges(
  before: TopLevelBlocks,
  after: TopLevelBlocks,
  docLength: number,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  let lastKept = -1;
  let keptEnd = 0;
  let newBlockSinceKept = false;
  for (let i = 0; i < after.nodes.length; i++) {
    const old = before.index.get(after.nodes[i]);
    if (old === undefined || old <= lastKept) {
      newBlockSinceKept = true;
      continue;
    }
    if (newBlockSinceKept || old !== lastKept + 1) {
      ranges.push({ from: keptEnd, to: after.from[i] });
    }
    lastKept = old;
    keptEnd = after.from[i] + after.nodes[i].length;
    newBlockSinceKept = false;
  }
  if (newBlockSinceKept || lastKept !== before.nodes.length - 1) {
    ranges.push({ from: keptEnd, to: docLength });
  }
  return ranges;
}

function mergeTouching(ranges: SourceRange[]): SourceRange[] {
  ranges.sort((a, b) => a.from - b.from);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

function inRegion(from: number, to: number, region: SourceRange): boolean {
  const before = from < region.from && to <= region.from;
  const after = from >= region.to && to > region.to;
  return !before && !after;
}

function build(source: NodeDecorationSource, state: EditorState): NodeDecorations {
  const tree = syntaxTree(state);
  return {
    decorations: Decoration.set(source.decorate(state, 0, state.doc.length), true),
    tree,
    blocks: topLevelBlocks(tree),
  };
}

export function incrementalNodeDecorations(
  source: NodeDecorationSource,
): StateField<NodeDecorations> {
  return StateField.define<NodeDecorations>({
    create: (state) => build(source, state),
    update(value, transaction) {
      const state = transaction.state;
      if (source.inputsChanged(transaction.startState, state)) {
        return build(source, state);
      }

      const tree = syntaxTree(state);
      const reach = source.changedReach(transaction);
      if (tree === value.tree && reach.length === 0 && !transaction.docChanged) {
        return value;
      }

      const dirty: SourceRange[] = [];
      let blocks = value.blocks;
      if (tree !== value.tree) {
        blocks = topLevelBlocks(tree);
        const parsedTo = Math.min(tree.length, state.doc.length);
        for (const range of changedRanges(value.blocks, blocks, parsedTo)) {
          if (range.from < range.to) {
            dirty.push(range);
          }
        }
      }
      for (const range of reach) {
        dirty.push({
          from: Math.max(0, range.from - 1),
          to: Math.min(state.doc.length, range.to + 1),
        });
      }

      let decorations = transaction.docChanged
        ? value.decorations.map(transaction.changes)
        : value.decorations;
      const regions = mergeTouching(dirty);
      if (tree.length < state.doc.length) {
        blocks = blocksAfterShortTree(tree, value.blocks, transaction, regions);
      }
      const add: Array<Range<Decoration>> = [];
      let previous: SourceRange | undefined;
      for (const region of regions) {
        const replaced = new Map<string, Decoration>();
        decorations = decorations.update({
          filterFrom: region.from,
          filterTo: region.to,
          filter: (from, to, decoration) => {
            if (!inRegion(from, to, region)) {
              return true;
            }
            replaced.set(`${from}-${to}`, decoration);
            return false;
          },
        });
        for (const range of source.decorate(state, region.from, region.to)) {
          const added = previous !== undefined && inRegion(range.from, range.to, previous);
          if (!inRegion(range.from, range.to, region) || added) {
            continue;
          }
          const old = replaced.get(`${range.from}-${range.to}`);
          add.push(old?.eq(range.value) === true ? old.range(range.from, range.to) : range);
        }
        previous = region;
      }
      if (add.length > 0) {
        decorations = decorations.update({ add, sort: true });
      }
      return { decorations, tree, blocks };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}
