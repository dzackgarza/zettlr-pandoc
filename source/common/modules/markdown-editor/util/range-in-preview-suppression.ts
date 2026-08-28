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

import type { EditorState } from '@codemirror/state'
import type { ViewUpdate } from '@codemirror/view'
import { getReviewChunks } from '../plugins/review-chunks'
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
/**
 * Whether this update changed what rangeInPreviewSuppression answers for
 * reasons no doc/viewport/selection guard can see: review chunks arrive and
 * leave through compartment reconfiguration, which dispatches a transaction
 * that changes none of those. Every renderer whose update guard consults
 * rangeInPreviewSuppression must also rebuild on this predicate — otherwise
 * widgets stay rendered over newly active chunks (hiding their controls), and
 * ranges stay raw after a review clears.
 */
export function reviewSuppressionChanged (update: ViewUpdate): boolean {
  return getReviewChunks(update.startState) !== getReviewChunks(update.state)
}

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
 * Whether an unresolved review chunk intersects [rangeFrom, rangeTo).
 *
 * Chunk positions are read on the B side: the working text lives in the
 * document, the reference on the A side. Non-empty chunks and renderer ranges
 * use CodeMirror's half-open convention, so adjacent ranges do not overlap.
 * A pure deletion is empty in B and its widget sits at a single point; only
 * that special case uses point containment.
 */
function rangeCarriesReviewChunk (
  state: EditorState,
  rangeFrom: number,
  rangeTo: number
): boolean {
  const chunks = getReviewChunks(state)
  if (chunks === null) {
    return false
  }
  return chunks.some(suggestion => {
    const ownedSpans = suggestion.anchors.filter(anchor => anchor.to > anchor.from)
    if (ownedSpans.length === 0) {
      const seam = suggestion.anchors[0]?.from ?? suggestion.seam
      return rangeFrom <= seam && seam < rangeTo
    }
    return ownedSpans.some(anchor => anchor.from < rangeTo && rangeFrom < anchor.to)
  })
}
