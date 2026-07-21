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
import { rangeInSelection } from './range-in-selection'

/**
 * Returns true when a normal live-preview renderer must leave a source range
 * raw because the range itself is selected. Container renderers, including
 * Pandoc fenced divs, manage their own editing presentation without
 * suppressing independent child renderers.
 */
export function rangeInPreviewSuppression (
  state: EditorState,
  rangeFrom: number,
  rangeTo: number,
  includeAdjacent: boolean = false
): boolean {
  return rangeInSelection(state.selection, rangeFrom, rangeTo, includeAdjacent)
}
