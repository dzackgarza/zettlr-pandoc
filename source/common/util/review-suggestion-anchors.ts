import { MapMode, type ChangeDesc } from '@codemirror/state'
import type { SuggestionSpan } from '@dts/common/review-domain'

export interface MappedSuggestionAnchors {
  anchors: SuggestionSpan[]
  seam: number
  changed: boolean
  destroyed: boolean
}

export function mapSuggestionAnchorCoordinates (
  anchors: readonly SuggestionSpan[],
  seam: number,
  changes: ChangeDesc
): MappedSuggestionAnchors {
  const edits: Array<{ from: number, to: number }> = []
  changes.iterChangedRanges((from, to) => edits.push({ from, to }), true)
  const mapped: SuggestionSpan[] = []

  for (const span of anchors) {
    if (span.from === span.to) {
      const point = changes.mapPos(span.from, 1, MapMode.TrackDel)
      if (point !== null) {
        mapped.push({ from: point, to: point })
      }
      continue
    }
    let cursor = span.from
    for (const edit of edits) {
      if (edit.from > span.to) { break }
      if (edit.to < cursor || (edit.from < span.from && edit.to <= span.from)) { continue }
      const unchangedTo = Math.min(edit.from, span.to)
      if (cursor < unchangedTo) {
        mapped.push({
          from: changes.mapPos(cursor, 1),
          to: changes.mapPos(unchangedTo, -1)
        })
      }
      cursor = Math.max(cursor, edit.to)
      if (cursor >= span.to) { break }
    }
    if (cursor < span.to) {
      mapped.push({
        from: changes.mapPos(cursor, 1),
        to: changes.mapPos(span.to, -1)
      })
    }
  }

  const mappedSeam = changes.mapPos(seam, 1)
  const changed =
    seam !== mappedSeam ||
    anchors.length !== mapped.length ||
    anchors.some((span, index) => {
      const next = mapped[index]
      return next === undefined || span.from !== next.from || span.to !== next.to
    })
  return {
    anchors: mapped,
    seam: mappedSeam,
    changed,
    destroyed: anchors.length > 0 && mapped.length === 0
  }
}
