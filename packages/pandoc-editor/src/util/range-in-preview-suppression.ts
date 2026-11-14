/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        previewSuppression, rangeInPreviewSuppression
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The ranges that the live preview leaves as source: the
 *                  selection, and the ranges that the host names, such as
 *                  the text of a pending review change.
 *
 *                  A host gives its ranges as a `PreviewSuppression`: a
 *                  query, and the ranges in which a value differs from the
 *                  value that it was made from. A renderer that keeps its
 *                  decorations through a transaction computes again only
 *                  those ranges, so the cost of a transaction follows the
 *                  ranges that it changed, not the number of ranges.
 *
 * END HEADER
 */

import { type ChangeDesc, type EditorState, Facet, type Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { rangeInSelection } from "./range-in-selection";

export interface SourceRange {
  from: number;
  to: number;
}

/**
 * The ranges of one state that a host keeps as source. An empty range
 * keeps the node that starts at it or holds it; another range keeps each
 * node that it overlaps.
 */
export interface PreviewSuppression {
  /** The identity of this value. */
  readonly id: number;
  /**
   * The identity of the value that this one was made from by one
   * transaction, or null for a value that was made from nothing.
   */
  readonly baseId: number | null;
  /**
   * The ranges of this document whose suppression can differ from the
   * value `baseId`, mapped through the transaction.
   */
  readonly changed: readonly SourceRange[];
  /** Whether the host keeps a part of `[from, to)` as source. */
  suppresses: (from: number, to: number) => boolean;
  /** Each range that the host keeps as source. */
  ranges: () => SourceRange[];
}

/** The ranges that a host keeps as source; one host at most. */
export const previewSuppression = Facet.define<PreviewSuppression, PreviewSuppression | null>({
  combine: (values) => {
    if (values.length > 1) {
      throw new Error(`preview suppression takes one host, received ${values.length}`);
    }
    return values.length === 0 ? null : values[0];
  },
});

export function reviewSuppressionChanged(update: ViewUpdate): boolean {
  return update.startState.facet(previewSuppression) !== update.state.facet(previewSuppression);
}

function mapped(range: SourceRange, changes: ChangeDesc): SourceRange {
  return { from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) };
}

/**
 * The ranges of the new document whose suppression a transaction can have
 * changed: the old and the new selection when either moved, and the ranges
 * that the host changed.
 */
export function previewSuppressionChangedRanges(transaction: Transaction): SourceRange[] {
  const { startState, state, changes } = transaction;
  const ranges: SourceRange[] = [];
  if (transaction.docChanged || startState.selection !== state.selection) {
    for (const range of startState.selection.ranges) {
      ranges.push(mapped(range, changes));
    }
    ranges.push(...state.selection.ranges);
  }
  const before = startState.facet(previewSuppression);
  const after = state.facet(previewSuppression);
  if (before === after) {
    return ranges;
  }
  if (before !== null && after !== null && after.baseId === before.id) {
    ranges.push(...after.changed);
    return ranges;
  }
  if (before !== null) {
    for (const range of before.ranges()) {
      ranges.push(mapped(range, changes));
    }
  }
  if (after !== null) {
    ranges.push(...after.ranges());
  }
  return ranges;
}

export function rangeInPreviewSuppression(
  state: EditorState,
  rangeFrom: number,
  rangeTo: number,
  includeAdjacent = false,
): boolean {
  if (rangeInSelection(state.selection, rangeFrom, rangeTo, includeAdjacent)) {
    return true;
  }
  const suppression = state.facet(previewSuppression);
  return suppression !== null && suppression.suppresses(rangeFrom, rangeTo);
}
