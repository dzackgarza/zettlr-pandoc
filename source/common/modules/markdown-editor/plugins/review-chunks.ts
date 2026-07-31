/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        reviewChunksExtension
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Renders review chunks as decorations over the live
 *                  document: the changed lines highlighted, the replaced
 *                  reference lines in a block widget above them, word-level
 *                  emphasis on what actually differs, and one Accept/Reject
 *                  control pair per chunk.
 *
 *                  The pane is a VIEW. The partition is computed by the same
 *                  shared engine the provider uses, from the same two texts
 *                  (the broadcast merge reference and this editor's buffer),
 *                  so the widgets here and the provider's chunk list agree by
 *                  construction. Clicking a control emits the chunk's
 *                  content-addressed id upward; the provider applies the
 *                  decision and broadcasts, and this field recomputes. The
 *                  pane never mutates review state and reports nothing back —
 *                  which is what retires the @codemirror/merge unifiedMergeView
 *                  this plugin replaces, whose accept/reject rewrote a local
 *                  copy of the reference that main then had to reconcile.
 *
 * END HEADER
 */

import { presentableDiff } from '@codemirror/merge'
import { Facet, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import {
  chunkAttributesTo,
  computeReviewChunks,
  type ReviewChunk
} from '@common/modules/review/review-chunks'
import type { ReviewPacketAttribution } from '@dts/common/review-diff'

export interface ReviewChunksConfig {
  reviewId: string
  /** The provider-owned merge reference the chunks are computed against. */
  referenceText: string
  /**
   * Every packet's attribution, from the provider's broadcast. A chunk shows
   * the descriptions of the packets whose reference spans it touches — the
   * same chunkAttributesTo rule the provider's chunk list uses, so the label
   * here and the API's attribution agree by construction.
   */
  packets: ReviewPacketAttribution[]
  /** Called with a chunk's content-addressed id when a control is clicked. */
  onDecide: (chunkId: string, decision: 'accept'|'reject') => void
}

const reviewChunksConfig = Facet.define<ReviewChunksConfig, ReviewChunksConfig|null>({
  combine: values => values.length > 0 ? values[0] : null
})

interface ReviewChunksFieldValue {
  chunks: ReviewChunk[]
  decorations: DecorationSet
}

const EMPTY: ReviewChunksFieldValue = { chunks: [], decorations: Decoration.none }

const reviewChunksField = StateField.define<ReviewChunksFieldValue>({
  create: buildFieldValue,
  update (value, tr) {
    if (tr.docChanged || tr.startState.facet(reviewChunksConfig) !== tr.state.facet(reviewChunksConfig)) {
      return buildFieldValue(tr.state)
    }
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
})

/**
 * The current review chunk partition, or null when no review is active in
 * this state. Live-preview suppression reads this to leave chunk-carrying
 * ranges un-rendered.
 */
export function getReviewChunks (state: EditorState): ReviewChunk[]|null {
  const value = state.field(reviewChunksField, false)
  return value === undefined ? null : value.chunks
}

export function reviewChunksExtension (config: ReviewChunksConfig): Extension[] {
  return [
    reviewChunksConfig.of(config),
    reviewChunksField,
    reviewChunksTheme
  ]
}

function buildFieldValue (state: EditorState): ReviewChunksFieldValue {
  const config = state.facet(reviewChunksConfig)
  if (config === null) {
    return EMPTY
  }
  const doc = state.doc
  const chunks = computeReviewChunks(config.referenceText, doc.toString())
  if (chunks.length === 0) {
    return { chunks, decorations: Decoration.none }
  }

  const ranges: Array<ReturnType<Decoration['range']>> = []
  for (const chunk of chunks) {
    // Anchor position: the start of the chunk's first working line, or the
    // end of the document for a pure deletion below the last line.
    const anchor = chunk.workFromLine <= doc.lines
      ? doc.line(chunk.workFromLine).from
      : doc.length

    // Word-level diff between the two sides, for display only. The insert
    // side is marked inside the document; the delete side inside the widget.
    const changes = presentableDiff(chunk.referenceText, chunk.workingText)

    // The claims this chunk came from, in packet application order.
    const descriptions = config.packets
      .filter(packet => chunkAttributesTo(chunk, packet.refSpans))
      .map(packet => packet.description)
      .filter((description): description is string => description !== undefined)

    ranges.push(
      Decoration.widget({
        widget: new DeletedLinesWidget(chunk, changes, descriptions, config),
        block: true,
        side: -10
      }).range(anchor)
    )

    for (let line = chunk.workFromLine; line < chunk.workToLine && line <= doc.lines; line++) {
      ranges.push(changedLine.range(doc.line(line).from))
    }
    for (const change of changes) {
      if (change.toB > change.fromB) {
        const from = anchor + change.fromB
        const to = Math.min(anchor + change.toB, doc.length)
        if (to > from) {
          ranges.push(changedText.range(from, to))
        }
      }
    }
  }
  return { chunks, decorations: Decoration.set(ranges, true) }
}

const changedLine = Decoration.line({ class: 'cm-changedLine' })
const changedText = Decoration.mark({ class: 'cm-changedText' })

/**
 * The block above a chunk: the reference lines this chunk replaces (empty for
 * a pure insertion), with the removed spans emphasised, and the Accept/Reject
 * controls. One widget per chunk — the controls sit in exactly one place.
 */
class DeletedLinesWidget extends WidgetType {
  constructor (
    private readonly chunk: ReviewChunk,
    private readonly changes: ReturnType<typeof presentableDiff>,
    private readonly descriptions: readonly string[],
    private readonly config: ReviewChunksConfig
  ) {
    super()
  }

  eq (other: DeletedLinesWidget): boolean {
    return other.chunk.chunkId === this.chunk.chunkId &&
      other.chunk.referenceText === this.chunk.referenceText &&
      other.chunk.workingText === this.chunk.workingText &&
      JSON.stringify(other.descriptions) === JSON.stringify(this.descriptions)
  }

  toDOM (): HTMLElement {
    const container = document.createElement('div')
    container.className = 'cm-deletedChunk'

    if (this.chunk.referenceText !== '') {
      container.appendChild(this.renderDeletedText())
    }

    // The claims this chunk implements — present at the controls, muted.
    if (this.descriptions.length > 0) {
      const list = document.createElement('div')
      list.className = 'cm-chunkDescriptions'
      for (const description of this.descriptions) {
        const entry = document.createElement('div')
        entry.className = 'cm-chunkDescription'
        entry.textContent = description
        list.appendChild(entry)
      }
      container.appendChild(list)
    }

    const buttons = document.createElement('div')
    buttons.className = 'cm-chunkButtons'
    for (const decision of ['accept', 'reject'] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.name = decision
      button.className = `cm-review-diff-control ${decision}`
      button.textContent = decision === 'accept' ? 'Accept' : 'Reject'
      button.title = decision === 'accept' ? 'Accept this change' : 'Reject this change'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        this.config.onDecide(this.chunk.chunkId, decision)
      })
      buttons.appendChild(button)
    }
    container.appendChild(buttons)
    return container
  }

  /** The reference lines, with the spans absent from the working side marked. */
  private renderDeletedText (): HTMLElement {
    const pre = document.createElement('div')
    pre.className = 'cm-deletedLines'
    const text = this.chunk.referenceText
    let position = 0
    for (const change of this.changes) {
      if (change.fromA > position) {
        pre.appendChild(document.createTextNode(text.slice(position, change.fromA)))
      }
      if (change.toA > change.fromA) {
        const del = document.createElement('del')
        del.className = 'cm-deletedText'
        del.textContent = text.slice(change.fromA, change.toA)
        pre.appendChild(del)
      }
      position = Math.max(position, change.toA)
    }
    if (position < text.length) {
      pre.appendChild(document.createTextNode(text.slice(position)))
    }
    return pre
  }

  ignoreEvent (): boolean {
    return true
  }
}

const reviewChunksTheme = EditorView.baseTheme({
  '.cm-changedLine': {
    backgroundColor: 'rgba(80, 160, 80, 0.12)'
  },
  '.cm-changedText': {
    backgroundColor: 'rgba(80, 160, 80, 0.28)',
    borderRadius: '2px'
  },
  '.cm-deletedChunk': {
    backgroundColor: 'rgba(200, 60, 60, 0.08)',
    borderLeft: '3px solid rgba(200, 60, 60, 0.55)',
    padding: '2px 6px'
  },
  '.cm-deletedLines': {
    whiteSpace: 'pre-wrap',
    fontFamily: 'inherit',
    color: 'rgba(140, 40, 40, 0.9)'
  },
  '&dark .cm-deletedLines': {
    color: 'rgba(240, 160, 160, 0.9)'
  },
  '.cm-deletedText': {
    backgroundColor: 'rgba(200, 60, 60, 0.25)',
    textDecoration: 'line-through'
  },
  '.cm-chunkDescriptions': {
    fontSize: '0.85em',
    opacity: '0.75',
    fontStyle: 'italic',
    padding: '2px 0'
  }
})
