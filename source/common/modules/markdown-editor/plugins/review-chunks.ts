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
 *                  Locators only (plan invariant I4). The chunk a mark names
 *                  is adjudicated in the annotations panel's
 *                  SuggestionInspector, which reads the same
 *                  DocumentCollaborationSession broadcast this extension is
 *                  configured from. The editor therefore carries no button,
 *                  no comment field, no status bar, and no review state of
 *                  its own: it maps the provider's anchors onto this buffer
 *                  and shows where the proposal lands.
 *
 * END HEADER
 */

import { Facet, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType
} from '@codemirror/view'
import type { ReviewSuggestionView } from '@dts/common/review-diff'
import { mapSuggestionThroughChanges } from '@common/util/review-suggestion-anchors'

export interface ReviewChunksConfig {
  suggestions: ReviewSuggestionView[]
}

const reviewChunksConfig = Facet.define<ReviewChunksConfig>()

function requireReviewChunksConfig (state: EditorState): ReviewChunksConfig {
  const configs = state.facet(reviewChunksConfig)
  if (configs.length !== 1) {
    throw new Error(`review chunks require exactly one configuration, received ${configs.length}`)
  }
  return configs[0]
}

interface ReviewChunksFieldValue {
  suggestions: ReviewSuggestionView[]
  decorations: DecorationSet
}

const reviewChunksField = StateField.define<ReviewChunksFieldValue>({
  create: buildFieldValue,
  update (value, tr) {
    if (tr.startState.facet(reviewChunksConfig) !== tr.state.facet(reviewChunksConfig)) {
      return buildFieldValue(tr.state)
    }
    if (tr.docChanged) {
      const suggestions = value.suggestions.flatMap(suggestion => {
        const mapped = mapSuggestionThroughChanges(
          suggestion,
          tr.changes,
          (from, to) => tr.startState.doc.sliceString(from, to)
        )
        return mapped.destroyed
          ? []
          : [{
              ...suggestion,
              anchors: mapped.anchors,
              seam: mapped.seam,
              removedText: mapped.removedText
            }]
      })
      return buildFieldValue(tr.state, suggestions)
    }
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
})

/**
 * The current proposed suggestions, or null when no review is active in
 * this state. Live-preview suppression reads this to leave chunk-carrying
 * ranges un-rendered.
 */
export function getReviewChunks (state: EditorState): ReviewSuggestionView[]|null {
  const value = state.field(reviewChunksField, false)
  return value === undefined ? null : value.suggestions
}

/** The anchor position of a suggestion, or document end. */
function suggestionAnchor (state: EditorState, suggestion: ReviewSuggestionView): number {
  const position = Math.min(suggestion.anchors[0]?.from ?? suggestion.seam, state.doc.length)
  return state.doc.lineAt(position).from
}

function selectReviewChunk (view: EditorView, direction: 1|-1): boolean {
  const value = view.state.field(reviewChunksField, false)
  if (value === undefined || value.suggestions.length === 0) {
    return false
  }
  const doc = view.state.doc
  const headLine = doc.lineAt(view.state.selection.main.head).number
  const suggestions = value.suggestions
  const target = direction === 1
    ? suggestions.find(suggestion => doc.lineAt(suggestionAnchor(view.state, suggestion)).number > headLine) ?? suggestions[0]
    : [...suggestions].reverse().find(suggestion => doc.lineAt(suggestionAnchor(view.state, suggestion)).number < headLine) ?? suggestions[suggestions.length - 1]
  const anchor = suggestionAnchor(view.state, target)
  view.dispatch({
    selection: { anchor },
    effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    userEvent: 'select'
  })
  return true
}

/** Move the cursor to the next review chunk, wrapping past the last one. */
export function selectNextReviewChunk (view: EditorView): boolean {
  return selectReviewChunk(view, 1)
}

/** Move the cursor to the previous review chunk, wrapping past the first. */
export function selectPreviousReviewChunk (view: EditorView): boolean {
  return selectReviewChunk(view, -1)
}

const reviewChunkKeymap = keymap.of([
  { key: 'F8', run: selectNextReviewChunk },
  { key: 'Shift-F8', run: selectPreviousReviewChunk }
])

export function reviewChunksExtension (config: ReviewChunksConfig): Extension[] {
  return [
    reviewChunksConfig.of(config),
    reviewChunksField,
    // The styling scope for every review mark, declared as an editor
    // attribute so CodeMirror itself maintains it. Added by hand via
    // classList it was silently wiped whenever CodeMirror re-synced the
    // element's class attribute (a resize re-measure, a focus change).
    EditorView.editorAttributes.of({ class: 'review-diff-active' }),
    reviewChunkKeymap,
    reviewChunksTheme
  ]
}

function buildFieldValue (
  state: EditorState,
  projectedSuggestions?: ReviewSuggestionView[]
): ReviewChunksFieldValue {
  const config = requireReviewChunksConfig(state)
  const doc = state.doc
  const suggestions = projectedSuggestions ?? config.suggestions
  if (suggestions.length === 0) {
    return { suggestions, decorations: Decoration.none }
  }

  const ranges: Array<ReturnType<Decoration['range']>> = []
  for (const suggestion of suggestions) {
    // The deleted spans, struck through in the document flow. A negative
    // side keeps a deleted span before an inserted one starting at the same
    // position, so a replacement reads old-then-new, like tracked changes.
    if (suggestion.removedText !== '') {
      ranges.push(
        Decoration.widget({
          widget: new DeletedSpanWidget(suggestion.suggestionId, suggestion.removedText),
          side: -1
        }).range(Math.min(suggestion.seam, doc.length))
      )
    }

    for (const span of suggestion.anchors) {
      const lastPosition = span.to > span.from ? span.to - 1 : span.from
      for (let line = doc.lineAt(span.from).number; line <= doc.lineAt(lastPosition).number; line++) {
        ranges.push(changedLine.range(doc.line(line).from))
      }
      if (span.to > span.from) {
        ranges.push(changedText.range(span.from, span.to))
      }
    }
  }
  return { suggestions, decorations: Decoration.set(ranges, true) }
}

const changedLine = Decoration.line({ class: 'cm-changedLine' })
const changedText = Decoration.mark({ class: 'cm-changedText' })

/**
 * One deleted span, struck through inline at the working-side position the
 * text was removed from. A locator, not a control: it shows WHERE the
 * proposal lands and WHAT it would take out, carries no decision, and
 * swallows every event.
 */
class DeletedSpanWidget extends WidgetType {
  constructor (
    private readonly chunkId: string,
    private readonly deletedText: string
  ) {
    super()
  }

  eq (other: DeletedSpanWidget): boolean {
    return other.chunkId === this.chunkId && other.deletedText === this.deletedText
  }

  toDOM (): HTMLElement {
    const del = document.createElement('del')
    del.className = 'cm-deletedText'
    del.textContent = this.deletedText
    return del
  }

  ignoreEvent (): boolean {
    return true
  }
}

const reviewChunksTheme = EditorView.baseTheme({
  '.cm-changedLine': {
    backgroundColor: 'var(--zettlr-editor-review-region-bg)'
  },
  '.cm-changedText': {
    backgroundColor: 'var(--zettlr-editor-review-insert-mark-bg)',
    borderRadius: '2px'
  },
  '.cm-deletedText': {
    backgroundColor: 'var(--zettlr-editor-review-delete-bg)',
    textDecoration: 'line-through',
    textDecorationThickness: '2px',
    textDecorationColor: 'var(--zettlr-editor-review-delete-accent)',
    whiteSpace: 'pre-wrap'
  }
})
