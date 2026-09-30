/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        incrementalNodeDecorations
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     A state field for decorations that are derived from syntax
 *                  nodes. A transaction computes again only the decorations
 *                  that it can change, so the work of a transaction follows
 *                  the size of the change and not the length of the document.
 *
 *                  A decoration can change for three reasons, and the field
 *                  has one rule for each:
 *
 *                  - The syntax tree changed. The Markdown parser keeps the
 *                    node object of each top-level block that it did not
 *                    parse again, so a block with the same node object has
 *                    the same decorations. The field computes again the
 *                    ranges between those blocks.
 *                  - A range that the source calls its reach moved. The
 *                    reach holds the ranges whose decorations depend on more
 *                    than their own nodes, such as the selection. The field
 *                    computes again the old and the new reach, and the
 *                    decorations that touch them.
 *                  - Another state value that the source reads changed. The
 *                    source reports that, and the field computes all
 *                    decorations again.
 *
 *                  All other decorations are mapped through the document
 *                  change. A widget in such a decoration is not created
 *                  again, so a widget must not keep a document position: it
 *                  reads its position from the view when it needs one.
 *
 *                  A decoration that the field computes again replaces the
 *                  one in its place only when the two are not equal. The
 *                  element of a widget therefore belongs to one widget object
 *                  until a different widget takes its place.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { Tree, type TreeBuffer } from '@lezer/common'

export interface SourceRange {
  from: number
  to: number
}

export interface NodeDecorationSource {
  /**
   * Returns the decorations of the syntax nodes that touch `[from, to]`. The
   * field keeps only the decorations that belong to that range themselves.
   */
  decorate: (state: EditorState, from: number, to: number) => Array<Range<Decoration>>
  /**
   * Whether a state value that `decorate` reads changed. The document, the
   * syntax tree and the selection are not such values.
   */
  inputsChanged: (before: EditorState, after: EditorState) => boolean
  /**
   * The ranges whose decorations depend on more than their own nodes: the
   * selection, for a source that leaves a selected node undecorated.
   */
  reach: (state: EditorState) => readonly SourceRange[]
  /** Whether `reach` can return other ranges for `after` than for `before`. */
  reachChanged: (before: EditorState, after: EditorState) => boolean
}

interface TopLevelBlocks {
  /** The node object of each top-level block and its start in the document. */
  nodes: Array<Tree|TreeBuffer>
  from: number[]
  /** The position of each node object in `nodes`. */
  index: Map<Tree|TreeBuffer, number>
}

interface NodeDecorations {
  decorations: DecorationSet
  tree: Tree
  blocks: TopLevelBlocks
}

// The parser groups a long list of blocks below anonymous nodes to balance
// the tree. It makes those nodes again for each parse, so they are not blocks.
function collectBlocks (tree: Tree, offset: number, blocks: TopLevelBlocks): void {
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i]
    const from = offset + tree.positions[i]
    if (child instanceof Tree && child.type.isAnonymous) {
      collectBlocks(child, from, blocks)
    } else {
      blocks.index.set(child, blocks.nodes.length)
      blocks.nodes.push(child)
      blocks.from.push(from)
    }
  }
}

// One tree has one list of blocks. Each field of an editor reads it for each
// tree, so the list is made once and lives as long as its tree.
const blocksOfTree = new WeakMap<Tree, TopLevelBlocks>()

function topLevelBlocks (tree: Tree): TopLevelBlocks {
  const known = blocksOfTree.get(tree)
  if (known !== undefined) {
    return known
  }
  const blocks: TopLevelBlocks = { nodes: [], from: [], index: new Map() }
  collectBlocks(tree, 0, blocks)
  blocksOfTree.set(tree, blocks)
  return blocks
}

/**
 * Returns the ranges of the new document that are not covered by a block
 * which the parser kept from the old tree.
 */
function changedRanges (before: TopLevelBlocks, after: TopLevelBlocks, docLength: number): SourceRange[] {
  const ranges: SourceRange[] = []
  let lastKept = -1
  let keptEnd = 0
  let newBlockSinceKept = false
  for (let i = 0; i < after.nodes.length; i++) {
    const old = before.index.get(after.nodes[i])
    if (old === undefined || old <= lastKept) {
      newBlockSinceKept = true
      continue
    }
    if (newBlockSinceKept || old !== lastKept + 1) {
      ranges.push({ from: keptEnd, to: after.from[i] })
    }
    lastKept = old
    keptEnd = after.from[i] + after.nodes[i].length
    newBlockSinceKept = false
  }
  if (newBlockSinceKept || lastKept !== before.nodes.length - 1) {
    ranges.push({ from: keptEnd, to: docLength })
  }
  return ranges
}

function mergeTouching (ranges: SourceRange[]): SourceRange[] {
  ranges.sort((a, b) => a.from - b.from)
  const merged: SourceRange[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range.from <= last.to) {
      last.to = Math.max(last.to, range.to)
    } else {
      merged.push({ from: range.from, to: range.to })
    }
  }
  return merged
}

/**
 * Whether a decoration belongs to a region that the field computes again. A
 * decoration that only meets the region at one of its ends belongs to the
 * unchanged block on that side. An empty decoration at such an end is what
 * remains of a deleted block, and belongs to the region.
 */
function inRegion (from: number, to: number, region: SourceRange): boolean {
  const before = from < region.from && to <= region.from
  const after = from >= region.to && to > region.to
  return !before && !after
}

function build (source: NodeDecorationSource, state: EditorState): NodeDecorations {
  const tree = syntaxTree(state)
  return {
    decorations: Decoration.set(source.decorate(state, 0, state.doc.length), true),
    tree,
    blocks: topLevelBlocks(tree)
  }
}

export function incrementalNodeDecorations (source: NodeDecorationSource): StateField<NodeDecorations> {
  return StateField.define<NodeDecorations>({
    create: state => build(source, state),
    update (value, transaction) {
      const state = transaction.state
      if (source.inputsChanged(transaction.startState, state)) {
        return build(source, state)
      }

      const tree = syntaxTree(state)
      const reachMoved = transaction.docChanged || source.reachChanged(transaction.startState, state)
      if (tree === value.tree && !reachMoved) {
        return value
      }

      const dirty: SourceRange[] = []
      let blocks = value.blocks
      if (tree !== value.tree) {
        blocks = topLevelBlocks(tree)
        dirty.push(...changedRanges(value.blocks, blocks, state.doc.length))
      }
      if (reachMoved) {
        // One position more on each side: a decoration that meets the reach
        // depends on it, and `inRegion` leaves out a decoration that only
        // meets a region.
        const widened = (from: number, to: number): SourceRange => {
          return { from: Math.max(0, from - 1), to: Math.min(state.doc.length, to + 1) }
        }
        for (const range of source.reach(transaction.startState)) {
          dirty.push(widened(transaction.changes.mapPos(range.from, -1), transaction.changes.mapPos(range.to, 1)))
        }
        for (const range of source.reach(state)) {
          dirty.push(widened(range.from, range.to))
        }
      }

      let decorations = transaction.docChanged
        ? value.decorations.map(transaction.changes)
        : value.decorations
      const regions = mergeTouching(dirty)
      const add: Array<Range<Decoration>> = []
      let previous: SourceRange|undefined
      for (const region of regions) {
        const replaced = new Map<string, Decoration>()
        decorations = decorations.update({
          filterFrom: region.from,
          filterTo: region.to,
          filter: (from, to, decoration) => {
            if (!inRegion(from, to, region)) {
              return true
            }
            replaced.set(`${from}-${to}`, decoration)
            return false
          }
        })
        for (const range of source.decorate(state, region.from, region.to)) {
          // A decoration that also belongs to the region before is already in `add`.
          const added = previous !== undefined && inRegion(range.from, range.to, previous)
          if (!inRegion(range.from, range.to, region) || added) {
            continue
          }
          const old = replaced.get(`${range.from}-${range.to}`)
          add.push(old?.eq(range.value) === true ? old.range(range.from, range.to) : range)
        }
        previous = region
      }
      if (add.length > 0) {
        decorations = decorations.update({ add, sort: true })
      }
      return { decorations, tree, blocks }
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations)
  })
}
