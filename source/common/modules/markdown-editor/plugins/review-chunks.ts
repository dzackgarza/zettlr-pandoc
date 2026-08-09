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
 *                  document: deleted reference spans struck through inline
 *                  at the positions they were removed from, inserted spans
 *                  highlighted in place, and one compact control strip with
 *                  the Accept/Reject decisions and the chunk's comment field
 *                  below each chunk.
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
import type { ReviewChunkCommentView, ReviewPacketAttribution } from '@dts/common/review-diff'
import type { ReviewComment } from '@dts/common/agent-api'

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
   * The chunk-anchored comments, from the provider's broadcast. A note
   * renders muted at its chunk's controls strip, like a description — an
   * edit inside the chunk retires the content-addressed id, at which point
   * it stops matching (the provider orphans the note's text).
   */
  chunkComments: ReviewChunkCommentView[]
  /** Review-level comments shown in the status panel. */
  comments: ReviewComment[]
  /** Called with a chunk's content-addressed id when a control is clicked. */
  onDecide: (chunkId: string, decision: 'accept'|'reject') => Promise<void>
  /**
   * Called when the status panel's Accept-all control is clicked. The
   * provider sweeps the whole partition through its one decision path and
   * broadcasts; this pane redraws from that broadcast, like any decision.
   */
  onAcceptAll: () => Promise<void>
  /** Called when the status panel rejects every remaining chunk. */
  onClear: () => Promise<void>
  /** Called when the status panel submits a review-level comment. */
  onComment: (text: string) => Promise<void>
  /**
   * Called when a chunk's own comment field commits. Annotation only: the
   * chunk stays outstanding. Non-empty text sets or replaces the note; an
   * empty text removes it.
   */
  onChunkComment: (chunkId: string, text: string) => Promise<void>
}

/**
 * Runs one review action with its controls dead for the round trip.
 *
 * A decision is a request, not a local edit: the provider owns review state
 * and its broadcast is what replaces these widgets. So a settled action does
 * NOT hand the controls back — they stay disabled until the broadcast rebuilds
 * them, which is what stops a second click landing on a chunk the first one
 * already resolved. Only a refusal re-enables, because a refusal changed
 * nothing and the reviewer may want to try again.
 */
async function withControlsLocked (
  container: HTMLElement,
  controls: HTMLButtonElement[],
  action: () => Promise<void>
): Promise<void> {
  container.setAttribute('aria-busy', 'true')
  for (const control of controls) {
    control.disabled = true
  }
  try {
    await action()
  } catch (err) {
    container.removeAttribute('aria-busy')
    for (const control of controls) {
      control.disabled = false
    }
    console.error('Review action refused', err)
  }
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
 * The review status bar: outstanding chunks at a glance, chunk
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
  // Set for the duration of a round trip so the per-update render below does
  // not hand the controls back while the provider is still deciding.
  let busy = false
  const runPanelAction = (action: () => Promise<void>): void => {
    busy = true
    void withControlsLocked(dom, [acceptAll, clear, commentSubmit], action)
      .finally(() => {
        busy = false
        render(view.state)
      })
  }
  const acceptAll = makeButton(
    'cm-review-diff-control cm-reviewAcceptAll',
    'Accept all',
    'Accept every remaining chunk',
    () => {
      const config = requireReviewChunksConfig(view.state)
      runPanelAction(async () => { await config.onAcceptAll() })
    }
  )
  const clear = makeButton(
    'cm-review-diff-control cm-reviewClear',
    'Reject remaining',
    'Reject every remaining change',
    () => {
      const config = requireReviewChunksConfig(view.state)
      runPanelAction(async () => { await config.onClear() })
    }
  )
  const commentList = document.createElement('div')
  commentList.className = 'cm-reviewComments'
  const commentInput = document.createElement('input')
  commentInput.type = 'text'
  commentInput.className = 'cm-reviewCommentInput'
  commentInput.placeholder = 'Review comment…'
  const commentSubmit = makeButton(
    'cm-review-diff-control cm-reviewCommentSubmit',
    'Comment',
    'Add a review-level comment',
    () => {
      const text = commentInput.value.trim()
      if (text === '') {return}
      const config = requireReviewChunksConfig(view.state)
      // The field clears only once the comment is committed; a refused one
      // stays typed so the reviewer does not lose it.
      runPanelAction(async () => {
        await config.onComment(text)
        commentInput.value = ''
      })
    }
  )
  commentInput.addEventListener('input', () => {
    commentSubmit.disabled = commentInput.value.trim() === ''
  })
  commentSubmit.disabled = true
  dom.append(previous, next, label, acceptAll, clear, commentList, commentInput, commentSubmit)

  const render = (state: EditorState): void => {
    // The panel outlives the review by a tick: a mass action that ends the
    // review takes this field out of the state before the action's promise
    // settles, and the `finally` below then renders against a state that no
    // longer describes a review. Reading the field unconditionally threw
    // "Field is not present in this state" out of an unhandled rejection.
    const value = state.field(reviewChunksField, false)
    if (value === undefined) {
      return
    }
    const chunks = value.chunks
    label.textContent = `${chunks.length} outstanding`
    const done = chunks.length === 0
    previous.disabled = done
    next.disabled = done
    acceptAll.disabled = done || busy
    clear.disabled = done || busy
    commentSubmit.disabled = busy || commentInput.value.trim() === ''
    commentList.replaceChildren(...requireReviewChunksConfig(state).comments.map(comment => {
      const entry = document.createElement('div')
      entry.className = 'cm-reviewComment'
      entry.textContent = comment.text
      return entry
    }))
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
    // side is marked inside the document; the delete side renders as inline
    // strikethrough widgets at the positions the text was removed from.
    const changes = presentableDiff(chunk.referenceText, chunk.workingText)

    // The claims this chunk came from, in packet application order.
    const descriptions = config.packets
      .filter(packet => chunkAttributesTo(chunk, packet.refSpans))
      .map(packet => packet.description)
      .filter((description): description is string => description !== undefined)

    const note = config.chunkComments.find(n => n.chunkId === chunk.chunkId) ?? config.chunkComments.find(n =>
      n.referenceText !== undefined &&
      n.workingText !== undefined &&
      n.referenceFromLine === chunk.refFromLine &&
      trimIdentitySeams(n.referenceText) === trimIdentitySeams(chunk.referenceText) &&
      trimIdentitySeams(n.workingText) === trimIdentitySeams(chunk.workingText)
    )

    // The deleted spans, struck through in the document flow. A negative
    // side keeps a deleted span before an inserted one starting at the same
    // position, so a replacement reads old-then-new, like tracked changes.
    changes.forEach((change, changeIndex) => {
      if (change.toA > change.fromA) {
        ranges.push(
          Decoration.widget({
            widget: new DeletedSpanWidget(
              chunk.chunkId,
              chunk.referenceText.slice(change.fromA, change.toA),
              changeIndex
            ),
            side: -1
          }).range(Math.min(anchor + change.fromB, doc.length))
        )
      }
    })

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

    // The controls strip sits below the chunk: after its last working line,
    // or after the line carrying the strikethrough for a pure deletion.
    const controlsLine = Math.min(Math.max(chunk.workToLine - 1, chunk.workFromLine), doc.lines)
    ranges.push(
      Decoration.widget({
        widget: new ChunkControlsWidget(chunk, descriptions, note, config),
        block: true,
        side: 10
      }).range(doc.line(controlsLine).to)
    )
  }
  return { chunks, decorations: Decoration.set(ranges, true) }
}

function trimIdentitySeams (text: string): string {
  return text.replace(/^\n+|\n+$/g, '')
}

const changedLine = Decoration.line({ class: 'cm-changedLine' })
const changedText = Decoration.mark({ class: 'cm-changedText' })

/**
 * One deleted span, struck through inline at the working-side position the
 * text was removed from. Display only: the widget swallows every event, and
 * the adjudication lives in the chunk's controls strip.
 */
class DeletedSpanWidget extends WidgetType {
  constructor (
    private readonly chunkId: string,
    private readonly deletedText: string,
    private readonly changeIndex: number
  ) {
    super()
  }

  eq (other: DeletedSpanWidget): boolean {
    return other.chunkId === this.chunkId &&
      other.deletedText === this.deletedText &&
      other.changeIndex === this.changeIndex
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

/** How long the chunk comment field waits after a keystroke before it commits. */
const CHUNK_NOTE_DEBOUNCE_MS = 750

interface ChunkNoteFieldState {
  /** The note text last acknowledged by the provider (or shown at build). */
  committed: string
  inflight: boolean
  timer: ReturnType<typeof setTimeout>|undefined
  /** Re-derives the saved/unsaved indicator from the value and `committed`. */
  syncIndicator: () => void
}

/** Reaches the field's live state from updateDOM/destroy, which only get the DOM. */
const noteFieldState = new WeakMap<HTMLInputElement, ChunkNoteFieldState>()

/**
 * (Re)render the strip's claim descriptions, in place, in front of the
 * buttons block. Everything here is display-only, so an update can rebuild
 * it freely — the comment input, which carries focus and unsent keystrokes,
 * is deliberately not touched. The chunk's note renders nowhere but that
 * input: it is the reviewer's annotation, not part of the review, and a
 * second copy in the strip would shift the layout on every autosave.
 */
function renderChunkMeta (
  container: HTMLElement,
  descriptions: readonly string[]
): void {
  for (const stale of container.querySelectorAll(':scope > .cm-chunkDescriptions')) {
    stale.remove()
  }
  const buttons = container.querySelector(':scope > .cm-chunkButtons')
  if (descriptions.length > 0) {
    const list = document.createElement('div')
    list.className = 'cm-chunkDescriptions'
    for (const description of descriptions) {
      const entry = document.createElement('div')
      entry.className = 'cm-chunkDescription'
      entry.textContent = description
      list.appendChild(entry)
    }
    container.insertBefore(list, buttons)
  }
}

/**
 * The strip below a chunk: the claim descriptions and the Accept/Reject
 * controls plus the comment field. One widget per chunk — the controls sit
 * in exactly one place. A comment is an annotation, not an adjudication:
 * the chunk stays outstanding, and the field is the note's only rendering —
 * the strip never repeats it.
 *
 * The comment field IS the annotation — there is no submit button. It
 * autosaves after a typing pause and immediately on blur or Enter, and an
 * emptied field removes the note. Every commit is a review mutation whose
 * broadcast rebuilds this widget's decorations, so the update path
 * (updateDOM) refreshes the strip IN PLACE and never replaces or rewrites
 * the input while the reviewer is typing in it: focus, cursor, and unsent
 * characters survive the round trip.
 */
class ChunkControlsWidget extends WidgetType {
  constructor (
    private readonly chunk: ReviewChunk,
    private readonly descriptions: readonly string[],
    private readonly note: ReviewChunkCommentView|undefined,
    private readonly config: ReviewChunksConfig
  ) {
    super()
  }

  eq (other: ChunkControlsWidget): boolean {
    return other.chunk.chunkId === this.chunk.chunkId &&
      other.chunk.referenceText === this.chunk.referenceText &&
      other.chunk.workingText === this.chunk.workingText &&
      other.config.reviewId === this.config.reviewId &&
      JSON.stringify(other.descriptions) === JSON.stringify(this.descriptions) &&
      other.note?.comment === this.note?.comment
  }

  toDOM (view: EditorView): HTMLElement {
    const container = document.createElement('div')
    container.className = 'cm-chunkControls'
    container.dataset.chunkId = this.chunk.chunkId

    const buttons = document.createElement('div')
    buttons.className = 'cm-chunkButtons'
    // The two decisions lock together for the round trip: they are mutually
    // exclusive, so leaving one live during the other's flight is an
    // invitation to double-decide.
    const controls: HTMLButtonElement[] = []
    const decide = (decision: 'accept'|'reject'): void => {
      void withControlsLocked(buttons, controls, async () => {
        // Resolved at click time, like the status panel's controls: a widget
        // whose chunk did not change survives a reconfigure, so the config it
        // was BUILT with can be older than the one on screen — and the
        // generation captured in it then fences the click against a review
        // state nobody is looking at any more.
        await requireReviewChunksConfig(view.state)
          .onDecide(this.chunk.chunkId, decision)
      })
    }
    for (const decision of ['accept', 'reject'] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.name = decision
      button.className = `cm-review-diff-control ${decision}`
      button.textContent = decision === 'accept' ? 'Accept' : 'Reject'
      button.title = decision === 'accept' ? 'Accept this change' : 'Reject this change'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        decide(decision)
      })
      controls.push(button)
      buttons.appendChild(button)
    }

    // The chunk's own comment field: the field is the annotation. It commits
    // at pause points, not on every keystroke — each commit is a review
    // mutation (generation bump, sidecar write, agent event).
    const noteInput = document.createElement('input')
    noteInput.type = 'text'
    noteInput.className = 'cm-chunkCommentInput'
    noteInput.placeholder = 'Comment…'
    noteInput.title = 'Annotate this change without deciding it; clearing the field removes the note'
    noteInput.value = this.note?.comment ?? ''
    // The dirty indicator answers one question: is this text agent-visible
    // yet? Unsaved the moment the value diverges from the last acknowledged
    // commit; saved only when the acknowledgment lands.
    const dirtyDot = document.createElement('span')
    dirtyDot.className = 'cm-chunkCommentDirty'
    dirtyDot.setAttribute('role', 'img')
    const state: ChunkNoteFieldState = {
      committed: this.note?.comment ?? '',
      inflight: false,
      timer: undefined,
      syncIndicator: () => {
        const unsaved = noteInput.value.trim() !== state.committed
        dirtyDot.classList.toggle('unsaved', unsaved)
        const label = unsaved
          ? 'Unsaved — not yet visible to agents'
          : 'Note saved — visible to agents'
        dirtyDot.title = label
        dirtyDot.setAttribute('aria-label', label)
      }
    }
    state.syncIndicator()
    noteFieldState.set(noteInput, state)
    const chunkId = this.chunk.chunkId
    const tryCommit = (): void => {
      clearTimeout(state.timer)
      state.timer = undefined
      const configs = view.state.facet(reviewChunksConfig)
      if (configs.length !== 1) {
        return // The review ended while the timer was pending.
      }
      const config = configs[0]
      const current = config.chunkComments
        .find(candidate => candidate.chunkId === chunkId)?.comment ?? ''
      if (state.inflight || current !== state.committed) {
        // Serialization: a commit is in flight, or its broadcast has not
        // reached this pane yet — committing now would bind a generation
        // that is about to be stale. Wait for the echo and retry.
        state.timer = setTimeout(tryCommit, CHUNK_NOTE_DEBOUNCE_MS)
        return
      }
      const text = noteInput.value.trim()
      if (text === state.committed) {
        return // Nothing changed; no phantom mutation.
      }
      state.inflight = true
      config.onChunkComment(chunkId, text)
        .then(() => { state.committed = text })
        .catch(err => { console.error('Chunk comment refused', err) })
        .finally(() => {
          state.inflight = false
          state.syncIndicator()
        })
    }
    noteInput.addEventListener('input', () => {
      state.syncIndicator()
      clearTimeout(state.timer)
      state.timer = setTimeout(tryCommit, CHUNK_NOTE_DEBOUNCE_MS)
    })
    noteInput.addEventListener('blur', tryCommit)
    noteInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        tryCommit()
      }
    })
    buttons.appendChild(noteInput)
    buttons.appendChild(dirtyDot)
    container.appendChild(buttons)
    renderChunkMeta(container, this.descriptions)
    return container
  }

  /**
   * Refresh the strip in place when only its display changed — the commit
   * echo of this very field, or reattributed descriptions. Replacing the DOM
   * here is what would eat the reviewer's focus and unsent keystrokes, so
   * the input is preserved and its value is only synchronized while nobody
   * is typing in it.
   */
  updateDOM (dom: HTMLElement): boolean {
    if (dom.dataset.chunkId !== this.chunk.chunkId) {
      return false
    }
    renderChunkMeta(dom, this.descriptions)
    const input = dom.querySelector<HTMLInputElement>('input.cm-chunkCommentInput')
    const state = input === null ? undefined : noteFieldState.get(input)
    if (input !== null && state !== undefined && document.activeElement !== input) {
      const value = this.note?.comment ?? ''
      input.value = value
      state.committed = value
      state.syncIndicator()
    }
    return true
  }

  destroy (dom: HTMLElement): void {
    const input = dom.querySelector<HTMLInputElement>('input.cm-chunkCommentInput')
    const state = input === null ? undefined : noteFieldState.get(input)
    if (state !== undefined) {
      clearTimeout(state.timer)
    }
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
  '.cm-chunkControls': {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    backgroundColor: 'var(--zettlr-editor-review-controls-bg)',
    borderLeft: '3px solid var(--zettlr-editor-review-delete-accent)',
    padding: '2px 6px',
    fontSize: '0.85em'
  },
  '.cm-chunkCommentInput': {
    fontSize: '0.85em',
    marginLeft: '4px',
    maxWidth: '18em'
  },
  '.cm-chunkCommentDirty': {
    display: 'inline-block',
    width: '0.5em',
    height: '0.5em',
    borderRadius: '50%',
    border: '1px solid currentColor',
    opacity: '0.25',
    alignSelf: 'center',
    marginLeft: '4px'
  },
  '.cm-chunkCommentDirty.unsaved': {
    opacity: '1',
    borderColor: 'var(--zettlr-editor-review-note-unsaved)'
  },
  '.cm-deletedText': {
    backgroundColor: 'var(--zettlr-editor-review-delete-bg)',
    textDecoration: 'line-through',
    textDecorationThickness: '2px',
    textDecorationColor: 'var(--zettlr-editor-review-delete-accent)',
    whiteSpace: 'pre-wrap'
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
