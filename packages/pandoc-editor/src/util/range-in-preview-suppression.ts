import { type EditorState, Facet } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { rangeInSelection } from "./range-in-selection";

export interface SourceRange {
  from: number;
  to: number;
}

/** Host-owned ranges that must stay editable, such as pending review changes. */
export const previewSuppression = Facet.define<readonly SourceRange[], readonly SourceRange[]>({
  combine: (values) => values.flat(),
});

export function reviewSuppressionChanged(update: ViewUpdate): boolean {
  return update.startState.facet(previewSuppression) !== update.state.facet(previewSuppression);
}

export function previewSuppressionRanges(state: EditorState): SourceRange[] {
  return [...state.selection.ranges, ...state.facet(previewSuppression)];
}

export function previewSuppressionChanged(before: EditorState, after: EditorState): boolean {
  return (
    before.selection !== after.selection ||
    before.facet(previewSuppression) !== after.facet(previewSuppression)
  );
}

export function rangeInPreviewSuppression(
  state: EditorState,
  rangeFrom: number,
  rangeTo: number,
  includeAdjacent = false,
): boolean {
  return (
    rangeInSelection(state.selection, rangeFrom, rangeTo, includeAdjacent) ||
    state
      .facet(previewSuppression)
      .some((range) =>
        range.from === range.to
          ? rangeFrom <= range.from && range.from < rangeTo
          : range.from < rangeTo && rangeFrom < range.to,
      )
  );
}
