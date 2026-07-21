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

import { syntaxTree } from '@codemirror/language'
import type { EditorState, SelectionRange } from '@codemirror/state'
import { rangeInSelection } from './range-in-selection'

interface SourceRange {
  from: number
  to: number
}

const activeDivRangeCache = new WeakMap<EditorState, readonly SourceRange[]>()

function selectionTouchesRange (
  selection: SelectionRange,
  range: SourceRange,
  includeAdjacent: boolean
): boolean {
  return includeAdjacent
    ? selection.to >= range.from && selection.from <= range.to
    : selection.to > range.from && selection.from < range.to
}

function activePandocDivRanges (state: EditorState, includeAdjacent: boolean): readonly SourceRange[] {
  // Adjacent-source display is an editor configuration, so states using the
  // opposite behavior must not share a cached result.
  if (includeAdjacent) {
    const cached = activeDivRangeCache.get(state)
    if (cached !== undefined) {
      return cached
    }
  }

  const divs: SourceRange[] = []
  syntaxTree(state).iterate({
    enter: node => {
      if (node.name !== 'PandocDiv') {
        return
      }

      // An incomplete div must remain ordinary raw source rather than
      // becoming a preview-suppression owner.
      if (node.node.getChildren('PandocDivMark').length === 2) {
        divs.push({ from: node.from, to: node.to })
      }
    },
  })

  const active = new Map<string, SourceRange>()
  for (const selection of state.selection.ranges) {
    const touched = divs.filter(div => selectionTouchesRange(selection, div, includeAdjacent))
    for (const candidate of touched) {
      const containsDeeperTouchedDiv = touched.some(other => {
        return other !== candidate &&
          candidate.from <= other.from &&
          candidate.to >= other.to &&
          (candidate.from !== other.from || candidate.to !== other.to)
      })
      if (!containsDeeperTouchedDiv) {
        active.set(`${candidate.from}:${candidate.to}`, candidate)
      }
    }
  }

  const result = [...active.values()]
  if (includeAdjacent) {
    activeDivRangeCache.set(state, result)
  }
  return result
}

/**
 * Returns true when a normal live-preview renderer must leave a source range
 * raw: either the range itself is selected, or it lies inside the deepest
 * fenced div currently being edited by any selection.
 */
export function rangeInPreviewSuppression (
  state: EditorState,
  rangeFrom: number,
  rangeTo: number,
  includeAdjacent: boolean = false
): boolean {
  if (rangeInSelection(state.selection, rangeFrom, rangeTo, includeAdjacent)) {
    return true
  }

  return activePandocDivRanges(state, includeAdjacent).some(div => {
    return rangeFrom >= div.from && rangeTo <= div.to
  })
}
