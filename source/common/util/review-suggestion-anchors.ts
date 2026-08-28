import { MapMode, type ChangeDesc } from '@codemirror/state'
import type { SuggestionSpan } from '@dts/common/review-domain'

export interface MappedSuggestion {
  anchors: SuggestionSpan[]
  seam: number
  /** What the mapped region held before the review touched it. */
  removedText: string
  changed: boolean
  destroyed: boolean
}

/** The text a suggestion was anchored in before the changes were applied. */
export type SliceBefore = (from: number, to: number) => string

interface Edit { fromA: number, toA: number, fromB: number, toB: number }

/**
 * Project one suggestion through a set of document changes.
 *
 * Two shapes of owner edit meet a suggestion, and they mean different things:
 *
 * - Text INSERTED inside the suggestion is the owner's, not the agent's, so
 *   the anchors split around it and it stays outside the region.
 * - Text the owner REPLACES is a rewrite of the region under review, so the
 *   suggestion absorbs the whole replaced stretch: its anchors cover what the
 *   owner wrote, and its reference grows to hold whatever that stretch read
 *   before the review — so rejecting it still restores the original passage,
 *   not just the words the agent put there.
 *
 * A deletion that puts nothing back replaces nothing: it leaves the split
 * path, where an anchor that loses all its text destroys the suggestion.
 */
export function mapSuggestionThroughChanges (
  suggestion: {
    anchors: readonly SuggestionSpan[]
    seam: number
    removedText: string
  },
  changes: ChangeDesc,
  sliceBefore: SliceBefore
): MappedSuggestion {
  const { anchors, seam, removedText } = suggestion
  const edits: Edit[] = []
  changes.iterChangedRanges(
    (fromA, toA, fromB, toB) => edits.push({ fromA, toA, fromB, toB }),
    true
  )

  const replacements = replacementsOver(anchors, edits)
  const mapped = replacements.length > 0
    ? absorbReplacements(anchors, removedText, replacements, changes, sliceBefore)
    : { anchors: splitAroundEdits(anchors, edits, changes), removedText }

  const first = mapped.anchors[0]
  const mappedSeam = first === undefined ? changes.mapPos(seam, 1) : first.from
  return {
    anchors: mapped.anchors,
    seam: mappedSeam,
    removedText: mapped.removedText,
    changed:
      seam !== mappedSeam ||
      removedText !== mapped.removedText ||
      anchors.length !== mapped.anchors.length ||
      anchors.some((span, index) => {
        const next = mapped.anchors[index]
        return next === undefined || span.from !== next.from || span.to !== next.to
      }),
    destroyed: anchors.length > 0 && mapped.anchors.length === 0
  }
}

/**
 * The edits that rewrote part of this suggestion: they delete some of it and
 * put text back. An edit that only inserts, or only deletes, is not one.
 */
function replacementsOver (
  anchors: readonly SuggestionSpan[],
  edits: readonly Edit[]
): Edit[] {
  if (anchors.length === 0) {
    return []
  }
  const from = anchors[0].from
  const to = anchors[anchors.length - 1].to
  return edits.filter(edit =>
    edit.toA > edit.fromA && edit.toB > edit.fromB &&
    edit.fromA < to && edit.toA > from
  )
}

/**
 * The owner rewrote part of the region: one anchor over the whole rewritten
 * stretch, and a reference that holds what the stretch read before the
 * review.
 */
// ponytail: one replacement that spans TWO suggestions is claimed by both,
// and the sidecar refuses the overlap rather than corrupting the review.
// Merging the two into one suggestion is the answer if that gesture matters.
function absorbReplacements (
  anchors: readonly SuggestionSpan[],
  removedText: string,
  replacements: readonly Edit[],
  changes: ChangeDesc,
  sliceBefore: SliceBefore
): { anchors: SuggestionSpan[], removedText: string } {
  const region = {
    from: anchors[0].from,
    to: anchors[anchors.length - 1].to
  }
  const low = Math.min(region.from, ...replacements.map(edit => edit.fromA))
  const high = Math.max(region.to, ...replacements.map(edit => edit.toA))
  // The reference is the absorbed stretch as it stood before the review: the
  // owner's own text where the anchors are not, and the removed text where
  // they are.
  let reference = ''
  let cursor = low
  for (const [index, span] of anchors.entries()) {
    reference += sliceBefore(cursor, span.from)
    if (index === 0) {
      reference += removedText
    }
    cursor = span.to
  }
  reference += sliceBefore(cursor, high)

  return {
    anchors: [{ from: changes.mapPos(low, -1), to: changes.mapPos(high, 1) }],
    removedText: reference
  }
}

/** The anchors with every inserted stretch inside them left out. */
function splitAroundEdits (
  anchors: readonly SuggestionSpan[],
  edits: readonly Edit[],
  changes: ChangeDesc
): SuggestionSpan[] {
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
      if (edit.fromA > span.to) { break }
      if (edit.toA < cursor || (edit.fromA < span.from && edit.toA <= span.from)) { continue }
      const unchangedTo = Math.min(edit.fromA, span.to)
      if (cursor < unchangedTo) {
        mapped.push({
          from: changes.mapPos(cursor, 1),
          to: changes.mapPos(unchangedTo, -1)
        })
      }
      cursor = Math.max(cursor, edit.toA)
      if (cursor >= span.to) { break }
    }
    if (cursor < span.to) {
      mapped.push({
        from: changes.mapPos(cursor, 1),
        to: changes.mapPos(span.to, -1)
      })
    }
  }
  return mapped
}
