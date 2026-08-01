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
import { Facet, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  type Panel,
  showPanel,
  WidgetType
} from '@codemirror/view'
import {
  chunkAttributesTo,
  computeReviewChunks,
  type ReviewChunk
} from '@common/modules/review/review-chunks'
import type { ReviewChunkHoldView, ReviewPacketAttribution } from '@dts/common/review-diff'

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
  /**
   * The held chunks, from the provider's broadcast. A held chunk renders
   * visually distinct, shows its comment, and keeps all three controls — an
   * edit inside it retires the content-addressed id, at which point it
   * simply renders pending again (the provider orphans the hold's comment).
   */
  holds: ReviewChunkHoldView[]
  /**
   * Called with a chunk's content-addressed id when a control is clicked.
   * Hold carries the optional comment typed into the chunk's note field.
   */
  onDecide: (chunkId: string, decision: 'accept'|'reject'|'hold', comment?: string) => void
  /**
   * Called when the status panel's Accept-all control is clicked. The
   * provider sweeps the whole partition through its one decision path and
   * broadcasts; this pane redraws from that broadcast, like any decision.
   */
  onAcceptAll: () => void
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
  chunks: ReviewChunk[]
  decorations: DecorationSet
}

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

/**
 * The most chunks this review has shown at once — the "total" of the status
 * panel's resolved/total indicator; resolved = highWater − outstanding. The
 * field survives the per-broadcast compartment reconfigure (same StateField
 * identity) and resets when the review extension is dropped.
 *
 * ponytail: a high-water mark, not a ledger — a user edit that merges two
 * chunks shrinks the outstanding count without a decision, which reads as
 * one more "resolved". Exact accounting would need decision history the
 * pane deliberately does not keep.
 */
const reviewChunkHighWater = StateField.define<number>({
  create (state) {
    return state.field(reviewChunksField).chunks.length
  },
  update (value, tr) {
    return Math.max(value, tr.state.field(reviewChunksField).chunks.length)
  }
})

/** The anchor position of a chunk: its first working line, or document end. */
function chunkAnchor (doc: Text, chunk: ReviewChunk): number {
  return chunk.workFromLine <= doc.lines ? doc.line(chunk.workFromLine).from : doc.length
}

function selectReviewChunk (view: EditorView, direction: 1|-1): boolean {
  const value = view.state.field(reviewChunksField, false)
  if (value === undefined || value.chunks.length === 0) {
    return false
  }
  const doc = view.state.doc
  const headLine = doc.lineAt(view.state.selection.main.head).number
  const chunks = value.chunks
  const target = direction === 1
    ? chunks.find(chunk => chunk.workFromLine > headLine) ?? chunks[0]
    : [...chunks].reverse().find(chunk => chunk.workFromLine < headLine) ?? chunks[chunks.length - 1]
  const anchor = chunkAnchor(doc, target)
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

/**
 * The review status bar: resolved/total (plus held) at a glance, chunk
 * navigation, and the mass-accept control. A module-level constructor keeps
 * the panel alive across the per-broadcast reconfigure; everything it shows
 * is re-read from the current state, and the click handlers resolve the
 * facet at click time so a stale config can never act.
 */
function reviewStatusPanel (view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-reviewStatusPanel'

  const makeButton = (className: string, text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = text
    button.title = title
    button.addEventListener('click', (event) => {
      event.preventDefault()
      onClick()
    })
    return button
  }

  const previous = makeButton('cm-reviewNav previous', '‹ Prev', 'Previous chunk (Shift-F8)', () => {
    selectPreviousReviewChunk(view)
  })
  const next = makeButton('cm-reviewNav next', 'Next ›', 'Next chunk (F8)', () => {
    selectNextReviewChunk(view)
  })
  const label = document.createElement('span')
  label.className = 'cm-reviewStatusLabel'
  const acceptAll = makeButton(
    'cm-review-diff-control cm-reviewAcceptAll',
    'Accept all',
    'Accept every remaining chunk',
    () => {
      requireReviewChunksConfig(view.state).onAcceptAll()
    }
  )
  dom.append(previous, next, label, acceptAll)

  const render = (state: EditorState): void => {
    const chunks = state.field(reviewChunksField).chunks
    const total = state.field(reviewChunkHighWater)
    const liveIds = new Set(chunks.map(chunk => chunk.chunkId))
    const held = requireReviewChunksConfig(state).holds
      .filter(hold => liveIds.has(hold.chunkId)).length
    const resolved = Math.max(0, total - chunks.length)
    label.textContent = `${resolved} of ${total} resolved` + (held > 0 ? ` · ${held} held` : '')
    const done = chunks.length === 0
    previous.disabled = done
    next.disabled = done
    acceptAll.disabled = done
  }
  render(view.state)

  return {
    dom,
    top: true,
    update (update) {
      render(update.state)
    }
  }
}

export function reviewChunksExtension (config: ReviewChunksConfig): Extension[] {
  return [
    reviewChunksConfig.of(config),
    reviewChunksField,
    reviewChunkHighWater,
    showPanel.of(reviewStatusPanel),
    reviewChunkKeymap,
    reviewChunksTheme
  ]
}

function buildFieldValue (state: EditorState): ReviewChunksFieldValue {
  const config = requireReviewChunksConfig(state)
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

    const hold = config.holds.find(h => h.chunkId === chunk.chunkId)

    ranges.push(
      Decoration.widget({
        widget: new DeletedLinesWidget(chunk, changes, descriptions, hold, config),
        block: true,
        side: -10
      }).range(anchor)
    )

    const lineDecoration = hold === undefined ? changedLine : heldLine
    for (let line = chunk.workFromLine; line < chunk.workToLine && line <= doc.lines; line++) {
      ranges.push(lineDecoration.range(doc.line(line).from))
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
const heldLine = Decoration.line({ class: 'cm-heldLine' })
const changedText = Decoration.mark({ class: 'cm-changedText' })

/**
 * The block above a chunk: the reference lines this chunk replaces (empty for
 * a pure insertion), with the removed spans emphasised, and the
 * Accept/Reject/Hold controls. One widget per chunk — the controls sit in
 * exactly one place. A held chunk renders visually distinct, shows the
 * hold's comment, and keeps every control: holding is an annotation, not an
 * adjudication.
 */
class DeletedLinesWidget extends WidgetType {
  constructor (
    private readonly chunk: ReviewChunk,
    private readonly changes: ReturnType<typeof presentableDiff>,
    private readonly descriptions: readonly string[],
    private readonly hold: ReviewChunkHoldView|undefined,
    private readonly config: ReviewChunksConfig
  ) {
    super()
  }

  eq (other: DeletedLinesWidget): boolean {
    return other.chunk.chunkId === this.chunk.chunkId &&
      other.chunk.referenceText === this.chunk.referenceText &&
      other.chunk.workingText === this.chunk.workingText &&
      JSON.stringify(other.descriptions) === JSON.stringify(this.descriptions) &&
      (other.hold === undefined) === (this.hold === undefined) &&
      other.hold?.comment === this.hold?.comment
  }

  toDOM (): HTMLElement {
    const container = document.createElement('div')
    container.className = this.hold === undefined
      ? 'cm-deletedChunk'
      : 'cm-deletedChunk held'

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

    if (this.hold?.comment !== undefined) {
      const note = document.createElement('div')
      note.className = 'cm-holdComment'
      note.textContent = `Held: ${this.hold.comment}`
      container.appendChild(note)
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

    // Hold, with its minimal optional-comment affordance: one inline note
    // field beside the button. Empty note = a bare hold; holding an already
    // held chunk replaces the comment (the field is prefilled with it).
    const holdButton = document.createElement('button')
    holdButton.type = 'button'
    holdButton.name = 'hold'
    holdButton.className = 'cm-review-diff-control hold'
    holdButton.textContent = this.hold === undefined ? 'Hold' : 'Update hold'
    holdButton.title = 'Hold this change without deciding it; the note goes back to the agent'
    const noteInput = document.createElement('input')
    noteInput.type = 'text'
    noteInput.className = 'cm-holdCommentInput'
    noteInput.placeholder = 'Optional note…'
    if (this.hold?.comment !== undefined) {
      noteInput.value = this.hold.comment
    }
    holdButton.addEventListener('click', (event) => {
      event.preventDefault()
      const note = noteInput.value.trim()
      this.config.onDecide(this.chunk.chunkId, 'hold', note === '' ? undefined : note)
    })
    buttons.appendChild(holdButton)
    buttons.appendChild(noteInput)
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
  '.cm-heldLine': {
    backgroundColor: 'rgba(220, 170, 40, 0.12)'
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
  '.cm-deletedChunk.held': {
    backgroundColor: 'rgba(220, 170, 40, 0.10)',
    borderLeft: '3px solid rgba(220, 170, 40, 0.65)'
  },
  '.cm-holdComment': {
    fontSize: '0.85em',
    fontStyle: 'italic',
    color: 'rgba(150, 110, 20, 0.95)',
    padding: '2px 0'
  },
  '&dark .cm-holdComment': {
    color: 'rgba(240, 200, 110, 0.9)'
  },
  '.cm-holdCommentInput': {
    fontSize: '0.85em',
    marginLeft: '4px',
    maxWidth: '18em'
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
  },
  '.cm-reviewStatusPanel': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 8px',
    fontSize: '0.85em'
  },
  '.cm-reviewStatusLabel': {
    opacity: '0.8',
    marginLeft: 'auto'
  }
})
