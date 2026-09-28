import { type ChangeDesc, MapMode } from "@codemirror/state";
import type { SuggestionSpan } from "@dts/common/review-domain";

export interface MappedSuggestion {
  anchors: SuggestionSpan[];
  seam: number;
  changed: boolean;
  destroyed: boolean;
}

interface Edit {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/**
 * Project one suggestion through a set of document changes.
 *
 * Every owner edit is the owner's own text, never the agent's, as in Fidus
 * Writer's track changes (`amend_transaction.js`): text the owner inserts or
 * writes over a suggestion stays outside its anchors, and the anchors keep
 * only the agent's characters that survive. Rejecting the suggestion
 * therefore removes only agent text and restores only what the agent took
 * out; the owner's typing is never discarded.
 *
 * A suggestion whose agent text is all gone keeps its identity while it
 * still has something to restore: its anchors collapse to one seam where the
 * text stood. A pure insertion with nothing left has nothing to decide, and
 * is destroyed.
 */
export function mapSuggestionThroughChanges(
  suggestion: {
    anchors: readonly SuggestionSpan[];
    seam: number;
    removedText: string;
  },
  changes: ChangeDesc,
): MappedSuggestion {
  const { anchors, seam, removedText } = suggestion;
  const edits: Edit[] = [];
  changes.iterChangedRanges(
    (fromA, toA, fromB, toB) => edits.push({ fromA, toA, fromB, toB }),
    true,
  );

  let mappedAnchors = splitAroundEdits(anchors, edits, changes);
  if (mappedAnchors.length === 0 && anchors.length > 0 && removedText !== "") {
    const point = changes.mapPos(anchors[0].from, -1);
    mappedAnchors = [{ from: point, to: point }];
  }

  const first = mappedAnchors[0];
  const mappedSeam = first === undefined ? changes.mapPos(seam, 1) : first.from;
  return {
    anchors: mappedAnchors,
    seam: mappedSeam,
    changed:
      seam !== mappedSeam ||
      anchors.length !== mappedAnchors.length ||
      anchors.some((span, index) => {
        const next = mappedAnchors[index];
        return next === undefined || span.from !== next.from || span.to !== next.to;
      }),
    destroyed: anchors.length > 0 && mappedAnchors.length === 0,
  };
}

/** A seam maps as the single position it is, and dies with the text under it. */
function mapSeamAnchor(span: SuggestionSpan, changes: ChangeDesc): SuggestionSpan[] {
  const point = changes.mapPos(span.from, 1, MapMode.TrackDel);
  return point === null ? [] : [{ from: point, to: point }];
}

/** True when this edit lies wholly outside the span still to be walked. */
function editMissesSpan(edit: Edit, span: SuggestionSpan, cursor: number): boolean {
  return edit.toA < cursor || (edit.fromA < span.from && edit.toA <= span.from);
}

/** One anchor's stretches that no edit touched, in document order. */
function splitSpan(
  span: SuggestionSpan,
  edits: readonly Edit[],
  changes: ChangeDesc,
): SuggestionSpan[] {
  if (span.from === span.to) {
    return mapSeamAnchor(span, changes);
  }
  const kept: SuggestionSpan[] = [];
  const keep = (from: number, to: number): void => {
    kept.push({ from: changes.mapPos(from, 1), to: changes.mapPos(to, -1) });
  };
  let cursor = span.from;
  for (const edit of edits) {
    if (edit.fromA > span.to) {
      break;
    }
    if (editMissesSpan(edit, span, cursor)) {
      continue;
    }
    const unchangedTo = Math.min(edit.fromA, span.to);
    if (cursor < unchangedTo) {
      keep(cursor, unchangedTo);
    }
    cursor = Math.max(cursor, edit.toA);
    if (cursor >= span.to) {
      break;
    }
  }
  if (cursor < span.to) {
    keep(cursor, span.to);
  }
  return kept;
}

/** The anchors with every stretch an edit touched left out. */
function splitAroundEdits(
  anchors: readonly SuggestionSpan[],
  edits: readonly Edit[],
  changes: ChangeDesc,
): SuggestionSpan[] {
  return anchors.flatMap((span) => splitSpan(span, edits, changes));
}
