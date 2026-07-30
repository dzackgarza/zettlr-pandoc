/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        rangeInPreviewSuppression
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Determines whether live-preview decorations should be
 *                  suppressed for a source range.
 *
 * END HEADER
 */

import { getChunks } from '@codemirror/merge'
import type { EditorState } from '@codemirror/state'
import { rangeInSelection } from './range-in-selection'

/**
 * Returns true when a normal live-preview renderer must leave a source range
 * raw because the range itself is selected. Container renderers, including
 * Pandoc fenced divs, manage their own editing presentation without
 * suppressing independent child renderers.
 *
 * A range carrying an unresolved review chunk is raw for the same reason. A
 * renderer replaces its whole source range with a widget, so a chunk landing
 * under one takes the changed line, the deleted-text block and the
 * Accept/Reject controls out of the document with it — a correction inside a
 * `$$…$$` block is invisible while the author scans the page, and only appears
 * if they happen to click into the equation and un-render it by editing.
 */
export function rangeInPreviewSuppression (
  state: EditorState,
  rangeFrom: number,
  rangeTo: number,
  includeAdjacent: boolean = false
): boolean {
  return rangeInSelection(state.selection, rangeFrom, rangeTo, includeAdjacent) ||
    rangeCarriesReviewChunk(state, rangeFrom, rangeTo)
}

/**
 * Whether an unresolved review chunk touches [rangeFrom, rangeTo].
 *
 * Chunk positions are read on the B side: a unified merge view keeps the
 * working text in the document and the reference on the A side. Bounds are
 * inclusive because a pure deletion is empty in B — its widget sits at a single
 * offset, and a renderer whose range merely reaches that offset still swallows
 * it.
 */
function rangeCarriesReviewChunk (
  state: EditorState,
  rangeFrom: number,
  rangeTo: number
): boolean {
  const chunks = getChunks(state)
  if (chunks === null) {
    return false
  }
  return chunks.chunks.some(chunk => chunk.fromB <= rangeTo && rangeFrom <= chunk.toB)
}
