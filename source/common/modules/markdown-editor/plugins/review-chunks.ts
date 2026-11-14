/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        reviewChunksExtension
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Renders review chunks as track changes over the live
 *                  document: removed suggestion text struck through inline
 *                  at the positions it was removed from, and inserted spans
 *                  highlighted in place.
 *
 *                  The field also records whether the chunks it holds were
 *                  built from the provider's latest broadcast (`synced`) or
 *                  have since been mapped through edits the provider has not
 *                  answered yet. The chunk controls (collaboration-controls.ts)
 *                  read that flag: a decision is fenced on the broadcast's
 *                  working-text hash, so a control acting on locally mapped
 *                  chunks would name text the provider does not hold.
 *
 *                  A review of a long document can have thousands of chunks
 *                  (#57). A typed character and the broadcast that answers
 *                  it cost work for the chunks that they change: the field
 *                  keeps the chunks in a range set by their extent, keeps
 *                  the decorations of each other chunk, and states the
 *                  chunks that it changed (`delta`, `changed`) so that the
 *                  controls and the renderers compute only those again.
 *
 * END HEADER
 */

import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  Facet,
  type Range,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { mapSuggestionThroughChanges } from "@common/util/review-suggestion-anchors";
import type { ReviewSuggestionView } from "@dts/common/review-diff";
import {
  type PreviewSuppression,
  previewSuppression,
  type SourceRange,
} from "@dzack/pandoc-editor/util/range-in-preview-suppression";

export interface ReviewChunksConfig {
  suggestions: ReviewSuggestionView[];
}

const reviewChunksConfig = Facet.define<ReviewChunksConfig>();

function requireReviewChunksConfig(state: EditorState): ReviewChunksConfig {
  const configs = state.facet(reviewChunksConfig);
  if (configs.length !== 1) {
    throw new Error(`review chunks require exactly one configuration, received ${configs.length}`);
  }
  return configs[0];
}

/**
 * Marks the installed chunks as out of step with the provider: a broadcast
 * arrived whose working text differs from this buffer, so the chunks shown
 * are the last synced ones, mapped locally, until the buffer catches up.
 */
export const markReviewChunksStale = StateEffect.define<null>();

/**
 * A broadcast of the installed review whose working text is the document of
 * the transaction: the suggestions of the provider, in its order, over that
 * document. Each suggestion that the broadcast does not change keeps its
 * decorations and its control.
 */
export const reviewChunksBroadcast = StateEffect.define<readonly ReviewSuggestionView[]>();

/**
 * One suggestion in the set of chunks. The range of the chunk is its
 * extent: the lines that it marks, from the start of the first one to the
 * end of the last one, and its seam. No decoration and no control of the
 * suggestion is outside the extent, so a change outside it moves the
 * suggestion and changes nothing else of it.
 */
class ReviewChunk extends RangeValue {
  constructor(
    /** The suggestion in the positions of the document where it was stored. */
    readonly suggestion: ReviewSuggestionView,
    /** The start of the extent in that document. */
    readonly storedFrom: number,
    /** The position of the suggestion in the list of the provider. */
    readonly order: number,
    /** The decorations of the suggestion. */
    readonly decorations: ReadonlySet<Decoration>,
  ) {
    super();
  }
}

/** The suggestion of a chunk whose extent starts at `from` now. */
function materialize(chunk: ReviewChunk, from: number): ReviewSuggestionView {
  const offset = from - chunk.storedFrom;
  if (offset === 0) {
    return chunk.suggestion;
  }
  return {
    ...chunk.suggestion,
    anchors: chunk.suggestion.anchors.map((anchor) => ({
      from: anchor.from + offset,
      to: anchor.to + offset,
    })),
    seam: chunk.suggestion.seam + offset,
  };
}

/** A chunk that a transaction removed or replaced, at its extent in the new document. */
export interface RemovedReviewChunk extends SourceRange {
  suggestionId: string;
}

/** What one transaction changed of the chunks of the value `baseId`. */
export interface ReviewChunksDelta {
  readonly removed: readonly RemovedReviewChunk[];
  /** The suggestions that the transaction added or replaced, in the new document. */
  readonly added: readonly ReviewSuggestionView[];
}

const noDelta: ReviewChunksDelta = { removed: [], added: [] };

let nextValueId = 0;

export class ReviewChunksFieldValue implements PreviewSuppression {
  readonly id = nextValueId++;
  readonly changed: readonly SourceRange[];
  private listed: ReviewSuggestionView[] | undefined;

  constructor(
    readonly chunks: RangeSet<ReviewChunk>,
    readonly decorations: DecorationSet,
    /** True while the chunks are exactly the provider's latest broadcast. */
    readonly synced: boolean,
    /** The number of chunks. */
    readonly count: number,
    readonly baseId: number | null,
    readonly delta: ReviewChunksDelta,
    /** The extents of the chunks of `delta.added`. */
    added: readonly SourceRange[],
  ) {
    this.changed = [...delta.removed, ...added];
  }

  /** The suggestions in the order of the provider. */
  suggestions(): ReviewSuggestionView[] {
    if (this.listed === undefined) {
      const chunks: Array<{ order: number; suggestion: ReviewSuggestionView }> = [];
      this.chunks.between(0, Number.MAX_SAFE_INTEGER, (from, _to, chunk) => {
        chunks.push({ order: chunk.order, suggestion: materialize(chunk, from) });
      });
      this.listed = inProviderOrder(chunks);
    }
    return this.listed;
  }

  /** The suggestions whose seam is in `[from, to]` or whose anchors overlap it. */
  touching(from: number, to: number): ReviewSuggestionView[] {
    const found: Array<{ order: number; suggestion: ReviewSuggestionView }> = [];
    this.chunks.between(from, to, (extentFrom, _extentTo, chunk) => {
      const suggestion = materialize(chunk, extentFrom);
      if (
        (suggestion.seam >= from && suggestion.seam <= to) ||
        suggestion.anchors.some((anchor) => anchor.from < to && anchor.to > from)
      ) {
        found.push({ order: chunk.order, suggestion });
      }
    });
    return inProviderOrder(found);
  }

  /**
   * A suggestion keeps its anchors with text as source; a suggestion with no
   * such anchor keeps the point where it stands.
   */
  suppresses(from: number, to: number): boolean {
    let suppressed = false;
    this.chunks.between(from, to, (extentFrom, _extentTo, chunk) => {
      const suggestion = materialize(chunk, extentFrom);
      const spans = suggestion.anchors.filter((anchor) => anchor.to > anchor.from);
      if (spans.length === 0) {
        const point = pointOf(suggestion);
        suppressed = from <= point && point < to;
      } else {
        suppressed = spans.some((span) => span.from < to && from < span.to);
      }
      if (suppressed) {
        return false;
      }
    });
    return suppressed;
  }

  /** The extent of each chunk, which holds each range that it keeps as source. */
  ranges(): SourceRange[] {
    const ranges: SourceRange[] = [];
    this.chunks.between(0, Number.MAX_SAFE_INTEGER, (from, to) => {
      ranges.push({ from, to });
    });
    return ranges;
  }
}

function inProviderOrder(
  chunks: Array<{ order: number; suggestion: ReviewSuggestionView }>,
): ReviewSuggestionView[] {
  return chunks.sort((left, right) => left.order - right.order).map((chunk) => chunk.suggestion);
}

/** The first anchor of a suggestion, or its seam when it has none. */
function pointOf(suggestion: ReviewSuggestionView): number {
  const first = suggestion.anchors.at(0);
  return first === undefined ? suggestion.seam : first.from;
}

/**
 * The end of the last line a suggestion touches: its last working span, or
 * the line carrying the strikethrough for a pure deletion. A span that ends
 * on a newline stops on the line that newline closes.
 */
function lastLineEnd(doc: Text, suggestion: ReviewSuggestionView): number {
  const last = suggestion.anchors.at(-1);
  const position =
    last === undefined ? suggestion.seam : last.to > last.from ? last.to - 1 : last.from;
  return doc.lineAt(Math.min(position, doc.length)).to;
}

/** The extent of a suggestion in a document: see `ReviewChunk`. */
function extentOf(doc: Text, suggestion: ReviewSuggestionView): SourceRange {
  const starts = [suggestion.seam, ...suggestion.anchors.map((anchor) => anchor.from)];
  const ends = [suggestion.seam, ...suggestion.anchors.map((anchor) => anchor.to)];
  return {
    from: doc.lineAt(Math.min(...starts, doc.length)).from,
    to: Math.min(Math.max(lastLineEnd(doc, suggestion), ...ends), doc.length),
  };
}

interface ChunkEntry {
  chunk: Range<ReviewChunk>;
  decorations: Array<Range<Decoration>>;
}

function entryOf(doc: Text, suggestion: ReviewSuggestionView, order: number): ChunkEntry {
  const extent = extentOf(doc, suggestion);
  const decorations = decorationsOf(doc, suggestion);
  const values = new Set(decorations.map((decoration) => decoration.value));
  return {
    chunk: new ReviewChunk(suggestion, extent.from, order, values).range(extent.from, extent.to),
    decorations,
  };
}

/**
 * The decorations of one suggestion. Each suggestion has decoration objects
 * of its own, so the field can remove the decorations of one chunk.
 */
function decorationsOf(doc: Text, suggestion: ReviewSuggestionView): Array<Range<Decoration>> {
  const ranges: Array<Range<Decoration>> = [];
  // The deleted spans, struck through in the document flow. A negative
  // side keeps a deleted span before an inserted one starting at the same
  // position, so a replacement reads old-then-new, like tracked changes.
  if (suggestion.removedText !== "") {
    ranges.push(
      Decoration.widget({
        widget: new DeletedSpanWidget(suggestion.suggestionId, suggestion.removedText),
        side: -1,
      }).range(Math.min(suggestion.seam, doc.length)),
    );
  }
  const changedLine = Decoration.line({ class: "cm-changedLine" });
  const changedText = Decoration.mark({ class: "cm-changedText" });
  for (const span of suggestion.anchors) {
    const lastPosition = span.to > span.from ? span.to - 1 : span.from;
    for (let line = doc.lineAt(span.from).number; line <= doc.lineAt(lastPosition).number; line++) {
      ranges.push(changedLine.range(doc.line(line).from));
    }
    if (span.to > span.from) {
      ranges.push(changedText.range(span.from, span.to));
    }
  }
  return ranges;
}

function valueOf(doc: Text, suggestions: readonly ReviewSuggestionView[]): ReviewChunksFieldValue {
  const entries = suggestions.map((suggestion, order) => entryOf(doc, suggestion, order));
  return new ReviewChunksFieldValue(
    RangeSet.of(
      entries.map((entry) => entry.chunk),
      true,
    ),
    Decoration.set(
      entries.flatMap((entry) => entry.decorations),
      true,
    ),
    true,
    entries.length,
    null,
    noDelta,
    [],
  );
}

/** The decorations without those of one chunk, whose extent is `extent`. */
function withoutDecorationsOf(
  decorations: DecorationSet,
  chunk: ReviewChunk,
  extent: SourceRange,
): DecorationSet {
  return decorations.update({
    filterFrom: extent.from,
    filterTo: extent.to,
    filter: (_from, _to, decoration) => !chunk.decorations.has(decoration),
  });
}

function mappedRange(range: SourceRange, changes: ChangeDesc): SourceRange {
  return { from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) };
}

function withEntries(
  value: ReviewChunksFieldValue,
  chunks: RangeSet<ReviewChunk>,
  decorations: DecorationSet,
  entries: readonly ChunkEntry[],
  synced: boolean,
  delta: ReviewChunksDelta,
): ReviewChunksFieldValue {
  if (entries.length > 0) {
    chunks = chunks.update({ add: entries.map((entry) => entry.chunk), sort: true });
    decorations = decorations.update({
      add: entries.flatMap((entry) => entry.decorations),
      sort: true,
    });
  }
  return new ReviewChunksFieldValue(
    chunks,
    decorations,
    synced,
    value.count - delta.removed.length + delta.added.length,
    value.id,
    delta,
    entries.map((entry) => ({ from: entry.chunk.from, to: entry.chunk.to })),
  );
}

/**
 * The chunks after a change of the document. A chunk whose extent the change
 * does not touch moves with the text; the field maps each other suggestion
 * as the provider maps it (`mapSuggestionThroughChanges`).
 */
function afterChanges(
  value: ReviewChunksFieldValue,
  transaction: Transaction,
): ReviewChunksFieldValue {
  const changes = transaction.changes;
  const touched: Array<{ chunk: ReviewChunk; extent: SourceRange }> = [];
  const seen = new Set<ReviewChunk>();
  changes.iterChangedRanges((fromA, toA) => {
    value.chunks.between(fromA, toA, (from, to, chunk) => {
      if (!seen.has(chunk)) {
        seen.add(chunk);
        touched.push({ chunk, extent: { from, to } });
      }
    });
  });

  let chunks = value.chunks;
  let decorations = value.decorations;
  for (const { chunk, extent } of touched) {
    chunks = chunks.update({
      filterFrom: extent.from,
      filterTo: extent.to,
      filter: (_from, _to, other) => other !== chunk,
    });
    decorations = withoutDecorationsOf(decorations, chunk, extent);
  }

  const doc = transaction.state.doc;
  const removed: RemovedReviewChunk[] = [];
  const added: ReviewSuggestionView[] = [];
  const entries: ChunkEntry[] = [];
  for (const { chunk, extent } of touched) {
    removed.push({ suggestionId: chunk.suggestion.suggestionId, ...mappedRange(extent, changes) });
    const suggestion = materialize(chunk, extent.from);
    const mapped = mapSuggestionThroughChanges(suggestion, changes);
    if (mapped.destroyed) {
      continue;
    }
    const moved = { ...suggestion, anchors: mapped.anchors, seam: mapped.seam };
    added.push(moved);
    entries.push(entryOf(doc, moved, chunk.order));
  }
  return withEntries(value, chunks.map(changes), decorations.map(changes), entries, false, {
    removed,
    added,
  });
}

function sameShape(left: ReviewSuggestionView, right: ReviewSuggestionView): boolean {
  return (
    left.removedText === right.removedText &&
    left.seam === right.seam &&
    left.anchors.length === right.anchors.length &&
    left.anchors.every(
      (anchor, index) =>
        anchor.from === right.anchors[index].from && anchor.to === right.anchors[index].to,
    )
  );
}

/**
 * The chunks of a broadcast. A suggestion whose anchors, seam and removed
 * text are those of the chunk shown keeps its decorations.
 */
function afterBroadcast(
  value: ReviewChunksFieldValue,
  doc: Text,
  suggestions: readonly ReviewSuggestionView[],
): ReviewChunksFieldValue {
  const shown = new Map<
    string,
    { chunk: ReviewChunk; suggestion: ReviewSuggestionView; extent: SourceRange }
  >();
  value.chunks.between(0, Number.MAX_SAFE_INTEGER, (from, to, chunk) => {
    shown.set(chunk.suggestion.suggestionId, {
      chunk,
      suggestion: materialize(chunk, from),
      extent: { from, to },
    });
  });

  const kept: Array<Range<ReviewChunk>> = [];
  const gone: Array<{ chunk: ReviewChunk; extent: SourceRange }> = [];
  const added: ReviewSuggestionView[] = [];
  const entries: ChunkEntry[] = [];
  suggestions.forEach((suggestion, order) => {
    const current = shown.get(suggestion.suggestionId);
    shown.delete(suggestion.suggestionId);
    if (current !== undefined && sameShape(current.suggestion, suggestion)) {
      const { from, to } = current.extent;
      kept.push(
        new ReviewChunk(suggestion, from, order, current.chunk.decorations).range(from, to),
      );
      return;
    }
    if (current !== undefined) {
      gone.push(current);
    }
    added.push(suggestion);
    entries.push(entryOf(doc, suggestion, order));
  });
  gone.push(...shown.values());

  let decorations = value.decorations;
  for (const { chunk, extent } of gone) {
    decorations = withoutDecorationsOf(decorations, chunk, extent);
  }
  const removed = gone.map(({ chunk, extent }) => ({
    suggestionId: chunk.suggestion.suggestionId,
    ...extent,
  }));
  return withEntries(value, RangeSet.of(kept, true), decorations, entries, true, {
    removed,
    added,
  });
}

const reviewChunksField = StateField.define<ReviewChunksFieldValue>({
  create: (state) => valueOf(state.doc, requireReviewChunksConfig(state).suggestions),
  update(value, transaction) {
    const state = transaction.state;
    if (transaction.startState.facet(reviewChunksConfig) !== state.facet(reviewChunksConfig)) {
      return valueOf(state.doc, requireReviewChunksConfig(state).suggestions);
    }
    const broadcast = transaction.effects
      .filter((effect) => effect.is(reviewChunksBroadcast))
      .at(-1);
    if (broadcast !== undefined && transaction.docChanged) {
      // The delta of a change and of a broadcast in one transaction would
      // name one chunk twice; the consumers compute each chunk again.
      return valueOf(state.doc, broadcast.value);
    }
    if (broadcast !== undefined) {
      return afterBroadcast(value, state.doc, broadcast.value);
    }
    if (transaction.docChanged) {
      return afterChanges(value, transaction);
    }
    if (value.synced && transaction.effects.some((effect) => effect.is(markReviewChunksStale))) {
      return withEntries(value, value.chunks, value.decorations, [], false, noDelta);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    previewSuppression.from(field),
  ],
});

/**
 * The current proposed suggestions, in the order of the provider, or null
 * when no review is active in this state.
 */
export function getReviewChunks(state: EditorState): ReviewSuggestionView[] | null {
  const value = state.field(reviewChunksField, false);
  return value === undefined ? null : value.suggestions();
}

/** The whole review field, or undefined when no review is installed. Its
 *  identity changes exactly when the chunks or their sync state do. */
export function getReviewChunksState(state: EditorState): ReviewChunksFieldValue | undefined {
  return state.field(reviewChunksField, false);
}

/**
 * Suggestions whose working-side anchors or deletion seam intersect a source
 * range. Renderers that replace source wholesale (notably the table widget)
 * use this to surface review state that ordinary mark decorations would hide.
 */
export function reviewSuggestionsInRange(
  state: EditorState,
  from: number,
  to: number,
): ReviewSuggestionView[] {
  const value = state.field(reviewChunksField, false);
  return value === undefined ? [] : value.touching(from, to);
}

/** The start of the line of the first anchor of a suggestion, or of its seam. */
function suggestionAnchor(state: EditorState, suggestion: ReviewSuggestionView): number {
  return state.doc.lineAt(Math.min(pointOf(suggestion), state.doc.length)).from;
}

/**
 * The end of the last line a suggestion touches: its last working span, or
 * the line carrying the strikethrough for a pure deletion.
 */
export function suggestionLastLineEnd(
  state: EditorState,
  suggestion: ReviewSuggestionView,
): number {
  return lastLineEnd(state.doc, suggestion);
}

function selectReviewChunk(view: EditorView, direction: 1 | -1): boolean {
  const suggestions = getReviewChunks(view.state);
  if (suggestions === null || suggestions.length === 0) {
    return false;
  }
  const doc = view.state.doc;
  const headLine = doc.lineAt(view.state.selection.main.head).number;
  const lineOf = (suggestion: ReviewSuggestionView): number =>
    doc.lineAt(suggestionAnchor(view.state, suggestion)).number;
  const after = suggestions.filter((suggestion) => lineOf(suggestion) > headLine);
  const before = suggestions.filter((suggestion) => lineOf(suggestion) < headLine);
  const target =
    direction === 1
      ? after.length > 0
        ? after[0]
        : suggestions[0]
      : before.length > 0
        ? before[before.length - 1]
        : suggestions[suggestions.length - 1];
  const anchor = suggestionAnchor(view.state, target);
  view.dispatch({
    selection: { anchor },
    effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    userEvent: "select",
  });
  return true;
}

/** Move the cursor to the next review chunk, wrapping past the last one. */
export function selectNextReviewChunk(view: EditorView): boolean {
  return selectReviewChunk(view, 1);
}

/** Move the cursor to the previous review chunk, wrapping past the first. */
export function selectPreviousReviewChunk(view: EditorView): boolean {
  return selectReviewChunk(view, -1);
}

/** The working-side stretch a suggestion covers: its seam and its anchors. */
function suggestionExtent(suggestion: ReviewSuggestionView): { from: number; to: number } {
  const ends = [
    suggestion.seam,
    ...suggestion.anchors.flatMap((anchor) => [anchor.from, anchor.to]),
  ];
  return { from: Math.min(...ends), to: Math.max(...ends) };
}

/** One suggestion written as CriticMarkup, followed by its justification. */
function criticMarkup(removed: string, inserted: string, description: string): string {
  const change =
    removed === ""
      ? `{++${inserted}++}`
      : inserted === ""
        ? `{--${removed}--}`
        : `{~~${removed}~>${inserted}~~}`;
  return `${change}{>>${description}<<}`;
}

/**
 * The main selection as CriticMarkup (https://criticmarkup.com/spec.php),
 * or null when it touches no pending suggestion. A suggestion the selection
 * touches is written whole: its removed text, the text it put in, and the
 * claim that justifies it. CodeMirror's own copy (`copiedRange` in
 * @codemirror/view) writes only document text, so the struck-through
 * removed text, which is a widget, would otherwise never reach the
 * clipboard.
 */
export function reviewSelectionAsCriticMarkup(state: EditorState): string | null {
  const suggestions = getReviewChunks(state);
  const { from, to } = state.selection.main;
  if (suggestions === null || from === to) {
    return null;
  }
  const touched = suggestions
    .map((suggestion) => ({ suggestion, extent: suggestionExtent(suggestion) }))
    .filter(({ extent }) => extent.from <= to && extent.to >= from)
    .sort((left, right) => left.extent.from - right.extent.from);
  if (touched.length === 0) {
    return null;
  }
  let text = "";
  let cursor = Math.min(from, touched[0].extent.from);
  for (const { suggestion, extent } of touched) {
    text += state.sliceDoc(cursor, extent.from);
    text += criticMarkup(
      suggestion.removedText,
      state.sliceDoc(extent.from, extent.to),
      suggestion.description,
    );
    cursor = extent.to;
  }
  return text + state.sliceDoc(cursor, Math.max(to, cursor));
}

const reviewCopyHandler = EditorView.domEventHandlers({
  copy(event, view) {
    const text = reviewSelectionAsCriticMarkup(view.state);
    if (text === null || event.clipboardData === null) {
      return false;
    }
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    return true;
  },
});

const reviewChunkKeymap = keymap.of([
  { key: "F8", run: selectNextReviewChunk },
  { key: "Shift-F8", run: selectPreviousReviewChunk },
]);

export function reviewChunksExtension(config: ReviewChunksConfig): Extension[] {
  return [
    reviewChunksConfig.of(config),
    reviewChunksField,
    // The styling scope for every review mark, declared as an editor
    // attribute so CodeMirror itself maintains it. Added by hand via
    // classList it was silently wiped whenever CodeMirror re-synced the
    // element's class attribute (a resize re-measure, a focus change).
    EditorView.editorAttributes.of({ class: "review-diff-active" }),
    reviewChunkKeymap,
    reviewCopyHandler,
    reviewChunksTheme,
  ];
}

/**
 * One deleted span, struck through inline at the working-side position the
 * text was removed from. It shows WHERE the proposal lands and WHAT it would
 * take out; the decision on it sits in the chunk's control block.
 */
class DeletedSpanWidget extends WidgetType {
  constructor(
    private readonly chunkId: string,
    private readonly deletedText: string,
  ) {
    super();
  }

  eq(other: DeletedSpanWidget): boolean {
    return other.chunkId === this.chunkId && other.deletedText === this.deletedText;
  }

  toDOM(): HTMLElement {
    const del = document.createElement("del");
    del.className = "cm-deletedText";
    del.textContent = this.deletedText;
    return del;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const reviewChunksTheme = EditorView.baseTheme({
  ".cm-changedLine": {
    backgroundColor: "var(--zettlr-editor-review-region-bg)",
  },
  ".cm-changedText": {
    backgroundColor: "var(--zettlr-editor-review-insert-mark-bg)",
    borderRadius: "2px",
  },
  ".cm-deletedText": {
    backgroundColor: "var(--zettlr-editor-review-delete-bg)",
    textDecoration: "line-through",
    textDecorationThickness: "2px",
    textDecorationColor: "var(--zettlr-editor-review-delete-accent)",
    whiteSpace: "pre-wrap",
  },
});
