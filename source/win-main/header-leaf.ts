/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Header leaf
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Which editor pane's document tab row is the window's
 *                  header row: the top-right pane of the pane tree. Its tab
 *                  row carries the sidebar and annotation panel toggles at
 *                  its right end; every other pane's row carries none.
 *
 * END HEADER
 */

import type { InjectionKey, Ref } from 'vue'
import type { BranchNodeJSON, LeafNodeJSON } from '@dts/common/documents'

/**
 * The leaf at the top right of a pane tree: in a side-by-side branch (the
 * document manager's 'horizontal' direction, panes sharing the width) the
 * last pane, in a stacked branch ('vertical', panes sharing the height) the
 * first.
 */
export function headerLeafId (node: BranchNodeJSON | LeafNodeJSON | undefined): string | undefined {
  if (node === undefined) {
    return undefined
  }
  if (node.type === 'leaf') {
    return node.id
  }
  const child = node.direction === 'horizontal' ? node.nodes[node.nodes.length - 1] : node.nodes[0]
  return headerLeafId(child)
}

/** Provided by the window; the document tab row of this leaf hosts the pane toggles. */
export const HEADER_LEAF_ID: InjectionKey<Ref<string | undefined>> = Symbol('header-leaf-id')
