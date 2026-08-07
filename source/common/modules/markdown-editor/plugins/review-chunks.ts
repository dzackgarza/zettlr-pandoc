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
 *                  the Accept/Reject/Hold decisions below each chunk.
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
   * The held chunks, from the provider's broadcast. A held chunk renders
   * visually distinct, shows its comment, and keeps all three controls — an
   * edit inside it retires the content-addressed id, at which point it
   * simply renders pending again (the provider orphans the hold's comment).
   */
  holds: ReviewChunkHoldView[]
  /** Review-level comments shown in the status panel. */
  comments: ReviewComment[]
  /**
   * Called with a chunk's content-addressed id when a control is clicked.
   * Hold carries the optional comment typed into the chunk's note field.
   */
  onDecide: (chunkId: string, decision: 'accept'|'reject'|'hold', comment?: string) => Promise<void>
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
 * The review status bar: outstanding chunks (plus held) at a glance, chunk
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
    const liveIds = new Set(chunks.map(chunk => chunk.chunkId))
    const held = requireReviewChunksConfig(state).holds
      .filter(hold => liveIds.has(hold.chunkId)).length
    label.textContent = `${chunks.length} outstanding` + (held > 0 ? ` · ${held} held` : '')
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

    const hold = config.holds.find(h => h.chunkId === chunk.chunkId) ?? config.holds.find(h =>
      h.referenceText !== undefined &&
      h.workingText !== undefined &&
      h.referenceFromLine === chunk.refFromLine &&
      trimIdentitySeams(h.referenceText) === trimIdentitySeams(chunk.referenceText) &&
      trimIdentitySeams(h.workingText) === trimIdentitySeams(chunk.workingText)
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

    // The controls strip sits below the chunk: after its last working line,
    // or after the line carrying the strikethrough for a pure deletion.
    const controlsLine = Math.min(Math.max(chunk.workToLine - 1, chunk.workFromLine), doc.lines)
    ranges.push(
      Decoration.widget({
        widget: new ChunkControlsWidget(chunk, descriptions, hold, config),
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
const heldLine = Decoration.line({ class: 'cm-heldLine' })
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

/**
 * The strip below a chunk: the claim descriptions, the hold's comment, and
 * the Accept/Reject/Hold controls. One widget per chunk — the controls sit
 * in exactly one place. A held chunk renders visually distinct, shows the
 * hold's comment, and keeps every control: holding is an annotation, not an
 * adjudication.
 */
class ChunkControlsWidget extends WidgetType {
  constructor (
    private readonly chunk: ReviewChunk,
    private readonly descriptions: readonly string[],
    private readonly hold: ReviewChunkHoldView|undefined,
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
      (other.hold === undefined) === (this.hold === undefined) &&
      other.hold?.comment === this.hold?.comment
  }

  toDOM (view: EditorView): HTMLElement {
    const container = document.createElement('div')
    container.className = this.hold === undefined
      ? 'cm-chunkControls'
      : 'cm-chunkControls held'

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
    // Every control of this chunk locks together for the round trip: the three
    // decisions are mutually exclusive, so leaving one live during another's
    // flight is an invitation to double-decide.
    const controls: HTMLButtonElement[] = []
    const decide = (decision: 'accept'|'reject'|'hold', comment?: string): void => {
      void withControlsLocked(buttons, controls, async () => {
        // Resolved at click time, like the status panel's controls: a widget
        // whose chunk did not change survives a reconfigure, so the config it
        // was BUILT with can be older than the one on screen — and the
        // generation captured in it then fences the click against a review
        // state nobody is looking at any more.
        await requireReviewChunksConfig(view.state)
          .onDecide(this.chunk.chunkId, decision, comment)
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
      decide('hold', note === '' ? undefined : note)
    })
    controls.push(holdButton)
    buttons.appendChild(holdButton)
    buttons.appendChild(noteInput)
    container.appendChild(buttons)
    return container
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
  '.cm-chunkControls': {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    backgroundColor: 'rgba(128, 128, 128, 0.06)',
    borderLeft: '3px solid rgba(200, 60, 60, 0.55)',
    padding: '2px 6px',
    fontSize: '0.85em'
  },
  '.cm-chunkControls.held': {
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
  '.cm-deletedText': {
    backgroundColor: 'rgba(200, 60, 60, 0.25)',
    textDecoration: 'line-through',
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
