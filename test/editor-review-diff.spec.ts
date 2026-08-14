/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor review-chunk rendering and control specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Mounts the production CodeMirror review-chunks plugin and
 *                  exercises only behavior owned by the editor view: chunk
 *                  rendering, control emissions, attribution, navigation, and
 *                  preview suppression. Provider decisions and persistence are
 *                  exercised by the assembled-app review lifecycle tests; this
 *                  suite does not simulate them.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  getReviewChunks,
  reviewChunksExtension,
  selectNextReviewChunk,
  selectPreviousReviewChunk
} from 'source/common/modules/markdown-editor/plugins/review-chunks'
import { computeReviewChunks } from 'source/common/modules/review/review-chunks'
import { rangeInPreviewSuppression } from 'source/common/modules/markdown-editor/util/range-in-preview-suppression'
import { renderLinks } from 'source/common/modules/markdown-editor/renderers/render-links'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'

function polyfillJsdomForCodeMirror (): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      Number(setTimeout(() => callback(Date.now()), 0))
    globalThis.cancelAnimationFrame = (id: number): void => { clearTimeout(id) }
  }
  if (typeof globalThis.window === 'object' && typeof globalThis.window.requestAnimationFrame !== 'function') {
    globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame
    globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame
  }
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    }
    if (typeof globalThis.window === 'object') {
      globalThis.window.ResizeObserver = globalThis.ResizeObserver
    }
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    class EmptyDOMRectList extends Array<DOMRect> {
      item (): DOMRect | null {
        return null
      }
    }
    Range.prototype.getClientRects = function (): DOMRectList {
      return new EmptyDOMRectList()
    }
    Range.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({})
      }
    }
  }
}

interface PacketView {
  packetId: string
  description?: string
  refSpans: Array<{ from: number, to: number }>
}

interface ChunkNoteView {
  chunkId: string
  comment: string
}

interface ReviewViewOptions {
  packets?: PacketView[]
  chunkComments?: ChunkNoteView[]
}

interface DecisionCall {
  chunkId: string
  decision: 'accept'|'reject'
}

interface ReviewCalls {
  decisions: DecisionCall[]
  acceptAll: number
  clear: number
  comments: string[]
  chunkNotes: Array<{ chunkId: string, text: string }>
}

describe('Editor review-chunk view', function () {
  const views: EditorView[] = []

  before(function () {
    polyfillJsdomForCodeMirror()
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createReviewView (
    referenceText: string,
    workingText: string,
    options: ReviewViewOptions = {}
  ): { view: EditorView, calls: ReviewCalls } {
    const calls: ReviewCalls = {
      decisions: [],
      acceptAll: 0,
      clear: 0,
      comments: [],
      chunkNotes: []
    }
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: workingText,
        extensions: [
          reviewChunksExtension({
            reviewId: 'review-test',
            referenceText,
            packets: options.packets ?? [],
            chunkComments: options.chunkComments ?? [],
            onDecide: async (chunkId, decision) => {
              calls.decisions.push({ chunkId, decision })
            },
            onAcceptAll: async () => { calls.acceptAll += 1 },
            onClear: async () => { calls.clear += 1 },
            onComment: async (text) => { calls.comments.push(text) },
            onChunkComment: async (chunkId, text) => { calls.chunkNotes.push({ chunkId, text }) }
          }),
          EditorView.updateListener.of(() => {})
        ]
      })
    })
    views.push(view)
    return { view, calls }
  }

  function chunksOf (view: EditorView): NonNullable<ReturnType<typeof getReviewChunks>> {
    const chunks = getReviewChunks(view.state)
    assert.ok(chunks !== null, 'the editor must be in review mode')
    return chunks
  }

  it('renders one decision control set per chunk and emits the addressed ids', function () {
    const baseline = [
      '# Note', '', 'first baseline', '', 'middle unchanged', '', 'second baseline', ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const { view, calls } = createReviewView(baseline, proposed)
    const chunks = chunksOf(view)
    assert.equal(chunks.length, 2)

    const accepts = view.dom.querySelectorAll<HTMLButtonElement>('button.cm-review-diff-control.accept')
    const rejects = view.dom.querySelectorAll<HTMLButtonElement>('button.cm-review-diff-control.reject')
    assert.equal(accepts.length, 2)
    assert.equal(rejects.length, 2)
    assert.equal(view.dom.querySelectorAll('input.cm-chunkCommentInput').length, 2)
    assert.equal(
      view.dom.querySelector('button.cm-review-diff-control.comment'),
      null,
      'the comment field IS the comment: no submit button exists'
    )

    accepts[0].click()
    rejects[1].click()

    assert.deepEqual(calls.decisions, [
      { chunkId: chunks[0].chunkId, decision: 'accept' },
      { chunkId: chunks[1].chunkId, decision: 'reject' }
    ])
    assert.equal(
      chunksOf(view).length,
      2,
      'the view must not optimistically apply provider decisions'
    )
  })

  /** The debounce plus a settle margin: what a test waits for an autosave. */
  const AUTOSAVE_WAIT_MS = 850

  function tick (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function noteInputOf (view: EditorView): HTMLInputElement {
    const input = view.dom.querySelector<HTMLInputElement>('input.cm-chunkCommentInput')
    assert.ok(input !== null, 'the chunk must render its comment field')
    return input
  }

  function typeInto (input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  }

  function dirtyDotOf (view: EditorView): HTMLElement {
    const dot = view.dom.querySelector<HTMLElement>('.cm-chunkCommentDirty')
    assert.ok(dot !== null, 'the comment field must render its saved/unsaved indicator')
    return dot
  }

  it('autosaves a trimmed chunk note after a typing pause, without blur', async function () {
    const { view, calls } = createReviewView('baseline\n', 'proposal\n')
    const chunk = chunksOf(view)[0]
    const input = noteInputOf(view)
    const dot = dirtyDotOf(view)
    assert.equal(dot.classList.contains('unsaved'), false, 'an untouched field is saved')
    input.focus()
    typeInto(input, '  check the constant  ')

    assert.deepEqual(calls.chunkNotes, [], 'no commit fires on the keystroke itself')
    assert.equal(dot.classList.contains('unsaved'), true, 'divergence flips the indicator at the keystroke')
    assert.equal(dot.title, 'Unsaved — not yet visible to agents')
    await tick(AUTOSAVE_WAIT_MS)
    assert.deepEqual(calls.chunkNotes, [
      { chunkId: chunk.chunkId, text: 'check the constant' }
    ])
    assert.equal(document.activeElement, input, 'autosave must not steal focus')
    assert.equal(dot.classList.contains('unsaved'), false, 'the acknowledgment flips it back to saved')
    assert.equal(dot.title, 'Note saved — visible to agents')
    assert.deepEqual(calls.decisions, [], 'a chunk comment decides nothing')
  })

  it('commits immediately on blur and on Enter', async function () {
    const { view, calls } = createReviewView('baseline\n', 'proposal\n')
    const chunk = chunksOf(view)[0]
    const input = noteInputOf(view)

    typeInto(input, 'first thought')
    input.dispatchEvent(new window.Event('blur'))
    await tick(0)
    assert.deepEqual(calls.chunkNotes, [
      { chunkId: chunk.chunkId, text: 'first thought' }
    ], 'blur must commit without waiting out the debounce')

    // The commit echo has not arrived in this harness, so the field retries
    // on its own schedule; an Enter on a fresh view proves the immediate
    // path independently.
    const second = createReviewView('other baseline\n', 'other proposal\n')
    const secondChunk = chunksOf(second.view)[0]
    const secondInput = noteInputOf(second.view)
    typeInto(secondInput, 'second thought')
    secondInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))
    await tick(0)
    assert.deepEqual(second.calls.chunkNotes, [
      { chunkId: secondChunk.chunkId, text: 'second thought' }
    ], 'Enter must commit without waiting out the debounce')
  })

  it('commits nothing when the value did not change', async function () {
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline.replace('first baseline', 'first proposed')
    const chunk = computeReviewChunks(baseline, proposed)[0]
    const { view, calls } = createReviewView(baseline, proposed, {
      chunkComments: [{ chunkId: chunk.chunkId, comment: 'as written' }]
    })
    const input = noteInputOf(view)
    assert.equal(input.value, 'as written', 'the field is prefilled with the note')

    input.dispatchEvent(new window.Event('blur'))
    typeInto(input, '  as written ')
    input.dispatchEvent(new window.Event('blur'))
    await tick(AUTOSAVE_WAIT_MS)
    assert.deepEqual(calls.chunkNotes, [], 'an unchanged note is no mutation')
  })

  it('commits an emptied field as the note\'s removal', async function () {
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline.replace('first baseline', 'first proposed')
    const chunk = computeReviewChunks(baseline, proposed)[0]
    const { view, calls } = createReviewView(baseline, proposed, {
      chunkComments: [{ chunkId: chunk.chunkId, comment: 'kill me' }]
    })
    const input = noteInputOf(view)

    typeInto(input, '')
    input.dispatchEvent(new window.Event('blur'))
    await tick(0)
    assert.deepEqual(calls.chunkNotes, [
      { chunkId: chunk.chunkId, text: '' }
    ], 'an emptied field removes the annotation')
  })

  it('keeps focus and unsent keystrokes across the commit echo redraw', async function () {
    // The critical autosave hazard: a commit mutates the review, the
    // broadcast reconfigures this extension, and the decoration rebuild
    // replaces widgets whose eq() changed — which is exactly this strip,
    // because its note changed. Replacing the DOM would eat the reviewer's
    // focus, cursor, and every character typed since the commit fired.
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline.replace('first baseline', 'first proposed')
    const notes: Array<{ chunkId: string, text: string }> = []
    const compartment = new Compartment()
    const configFor = (chunkComments: ChunkNoteView[]): Parameters<typeof reviewChunksExtension>[0] => ({
      reviewId: 'review-test',
      referenceText: baseline,
      packets: [],
      chunkComments,
      onDecide: async () => {},
      onAcceptAll: async () => {},
      onClear: async () => {},
      onComment: async () => {},
      onChunkComment: async (chunkId, text) => { notes.push({ chunkId, text }) }
    })
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: proposed,
        extensions: [compartment.of(reviewChunksExtension(configFor([])))]
      })
    })
    views.push(view)
    const chunk = chunksOf(view)[0]
    const input = noteInputOf(view)
    input.focus()

    typeInto(input, 'first')
    await tick(AUTOSAVE_WAIT_MS)
    assert.deepEqual(notes, [{ chunkId: chunk.chunkId, text: 'first' }])

    // Keep typing BEFORE the provider's echo lands...
    typeInto(input, 'first second')
    assert.equal(
      dirtyDotOf(view).classList.contains('unsaved'),
      true,
      'the resumed typing is not agent-visible yet'
    )
    // ...then the echo: the broadcast MainEditor would apply, carrying the
    // committed note. The widget's eq() changes, decorations rebuild.
    view.dispatch({
      effects: compartment.reconfigure(
        reviewChunksExtension(configFor([{ chunkId: chunk.chunkId, comment: 'first' }]))
      )
    })

    assert.equal(document.activeElement, input, 'the echo redraw must not eat focus')
    assert.equal(input.value, 'first second', 'unsent keystrokes must survive the redraw')
    assert.equal(
      dirtyDotOf(view).classList.contains('unsaved'),
      true,
      'the in-place redraw keeps the indicator honest: still unsaved'
    )
    assert.equal(
      view.dom.querySelector<HTMLElement>('.cm-chunkComment'),
      null,
      'the field is the note\'s only rendering — the echo must not append a copy to the strip'
    )

    // The interrupted typing commits on its own once the echo has settled.
    await tick(AUTOSAVE_WAIT_MS)
    assert.deepEqual(notes, [
      { chunkId: chunk.chunkId, text: 'first' },
      { chunkId: chunk.chunkId, text: 'first second' }
    ])
    assert.equal(
      dirtyDotOf(view).classList.contains('unsaved'),
      false,
      'everything typed is acknowledged: saved again'
    )
  })

  it('shows a provider-supplied chunk comment only in the comment field', function () {
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline.replace('first baseline', 'first proposed')
    const chunk = computeReviewChunks(baseline, proposed)[0]
    const { view } = createReviewView(baseline, proposed, {
      chunkComments: [{ chunkId: chunk.chunkId, comment: 'check the constant' }]
    })

    const widget = view.dom.querySelector<HTMLElement>('.cm-chunkControls')
    assert.ok(widget !== null)
    assert.equal(
      widget.querySelector<HTMLInputElement>('input.cm-chunkCommentInput')?.value,
      'check the constant',
      'the field is prefilled so editing it replaces the note'
    )
    assert.equal(
      widget.querySelector<HTMLElement>('.cm-chunkComment'),
      null,
      'the note is not duplicated into the strip alongside the claim descriptions'
    )
    assert.ok(widget.querySelector('button.accept') !== null)
    assert.ok(widget.querySelector('button.reject') !== null)
  })

  it('shows each claim description at its own chunk and preserves it across a working-text tweak', function () {
    const baseline = [
      '# Note', '', 'first baseline', '', 'middle unchanged', '', 'second baseline', ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const partition = computeReviewChunks(baseline, proposed)
    assert.equal(partition.length, 2)

    const { view } = createReviewView(baseline, proposed, {
      packets: [
        {
          packetId: 'packet-1',
          description: 'Sharpen the opening claim',
          refSpans: [{ from: partition[0].refFromLine, to: partition[0].refToLine }]
        },
        {
          packetId: 'packet-2',
          description: 'Fix the closing claim',
          refSpans: [{ from: partition[1].refFromLine, to: partition[1].refToLine }]
        }
      ]
    })

    const widgets = [...view.dom.querySelectorAll<HTMLElement>('.cm-chunkControls')]
    assert.deepEqual(
      widgets.map(widget =>
        [...widget.querySelectorAll('.cm-chunkDescription')].map(entry => entry.textContent)
      ),
      [['Sharpen the opening claim'], ['Fix the closing claim']]
    )

    const firstChunk = chunksOf(view)[0]
    const insertAt = view.state.doc.line(firstChunk.workFromLine).to
    view.dispatch({ changes: { from: insertAt, insert: ' (tweaked)' } })

    assert.equal(
      view.dom.querySelector<HTMLElement>('.cm-chunkControls .cm-chunkDescription')?.textContent,
      'Sharpen the opening claim'
    )
  })

  it('never renders controls over a region the user typed (#65)', function () {
    // Adjudication is a decision about a proposal. A paragraph the reviewer
    // edited themselves disagrees with the frozen reference just as loudly,
    // but no packet claims it — so it carries no controls, no highlight, and
    // no place in the outstanding count.
    const baseline = 'first baseline\n\nsecond baseline\n'
    const working = 'first proposed\n\nsecond typed by hand\n'
    const partition = computeReviewChunks(baseline, working)
    assert.equal(partition.length, 2, 'the raw partition sees both paragraphs')

    const { view } = createReviewView(baseline, working, {
      packets: [{
        packetId: 'packet-1',
        description: 'Sharpen the opening claim',
        refSpans: [{ from: partition[0].refFromLine, to: partition[0].refToLine }]
      }]
    })

    const chunks = chunksOf(view)
    assert.equal(chunks.length, 1, 'only the attributed edit is adjudicable')
    assert.equal(chunks[0].workingText, 'first proposed')
    assert.equal(view.dom.querySelectorAll('.cm-chunkControls').length, 1)
    assert.equal(
      view.dom.querySelector<HTMLElement>('.cm-reviewStatusLabel')?.textContent,
      '1 outstanding'
    )
    const typedLine = view.state.doc.line(3)
    assert.equal(
      rangeInPreviewSuppression(view.state, typedLine.from, typedLine.to),
      false,
      'the user\'s own paragraph keeps its live preview'
    )
  })

  it('renders a small replacement as inline track changes with one controls strip', function () {
    const baseline = ['alpha', '', 'the original wording stays here', ''].join('\n')
    const proposed = baseline.replace('original wording', 'revised wording')
    const chunk = computeReviewChunks(baseline, proposed)[0]
    const { view } = createReviewView(baseline, proposed, {
      packets: [{
        packetId: 'packet-1',
        description: 'Revise the wording',
        refSpans: [{ from: chunk.refFromLine, to: chunk.refToLine }]
      }]
    })

    assert.equal(view.dom.querySelector('.cm-deletedChunk'), null, 'the delta renders in the document flow, not a block above it')
    const deleted = view.dom.querySelector<HTMLElement>('del.cm-deletedText')
    assert.ok(deleted !== null)
    assert.equal(deleted.textContent, 'original')
    const line = deleted.closest<HTMLElement>('.cm-line')
    assert.ok(line !== null, 'the strikethrough sits inside the working line')
    assert.equal(
      line.textContent,
      'the originalrevised wording stays here',
      'the deleted span reads before its replacement, in one pass'
    )

    const strips = view.dom.querySelectorAll<HTMLElement>('.cm-chunkControls')
    assert.equal(strips.length, 1)
    assert.ok(strips[0].querySelector('button.cm-review-diff-control.accept') !== null)
    assert.ok(strips[0].querySelector('button.cm-review-diff-control.reject') !== null)
    assert.ok(strips[0].querySelector('input.cm-chunkCommentInput') !== null)
    assert.equal(
      strips[0].querySelector<HTMLElement>('.cm-chunkDescription')?.textContent,
      'Revise the wording'
    )
  })

  it('renders a whole-line deletion as inline strikethrough with its controls strip', function () {
    const { view } = createReviewView(
      'prefix\nfirst removed\nsecond removed\nunchanged\n',
      'prefix\nunchanged\n'
    )

    assert.equal(view.dom.querySelector('.cm-deletedChunk'), null)
    const deleted = view.dom.querySelectorAll<HTMLElement>('del.cm-deletedText')
    assert.equal(deleted.length, 1)
    assert.equal(deleted[0].textContent, 'first removed\nsecond removed')
    const strips = view.dom.querySelectorAll<HTMLElement>('.cm-chunkControls')
    assert.equal(strips.length, 1)
    assert.ok(strips[0].querySelector('button.cm-review-diff-control.accept') !== null)
  })

  it('keeps a heavy rewrite merged in the document flow', function () {
    const { view } = createReviewView(
      'alpha beta gamma delta\n',
      'completely different words now\n'
    )

    assert.equal(view.dom.querySelector('.cm-deletedChunk'), null)
    const deleted = view.dom.querySelector<HTMLElement>('del.cm-deletedText')
    assert.equal(deleted?.textContent, 'alpha beta gamma delta')
    const line = deleted?.closest<HTMLElement>('.cm-line')
    assert.ok(line !== null && line !== undefined, 'the deleted span sits inside a document line')
    const lineText = line.textContent
    assert.ok(lineText !== null && lineText.includes('completely different words now'))
    assert.equal(view.dom.querySelectorAll('.cm-chunkControls').length, 1)
  })

  it('suppresses live-preview rendering only over a range carrying a review chunk', function () {
    const baseline = [
      'intro paragraph', '', '$$', 'p_a(C) = 10', '$$', '', 'closing paragraph', ''
    ].join('\n')
    const proposed = baseline.replace('p_a(C) = 10', 'g(C) = 10')
    const { view } = createReviewView(baseline, proposed)

    assert.equal(
      rangeInPreviewSuppression(
        view.state,
        view.state.doc.line(3).from,
        view.state.doc.line(5).to
      ),
      true
    )
    const intro = view.state.doc.line(1)
    assert.equal(rangeInPreviewSuppression(view.state, intro.from, intro.to), false)
  })

  it('uses half-open chunk overlap while preserving deletion-point suppression', function () {
    const adjacent = createReviewView('alpha\nunchanged', 'ALPHA\nunchanged').view
    const unchanged = adjacent.state.doc.line(2)
    assert.equal(
      rangeInPreviewSuppression(adjacent.state, unchanged.from, unchanged.to),
      false
    )

    const deletion = createReviewView(
      'prefix\nremoved\nunchanged',
      'prefix\nunchanged'
    ).view
    const surviving = deletion.state.doc.line(2)
    assert.equal(
      rangeInPreviewSuppression(deletion.state, surviving.from, surviving.to),
      true
    )

    const deletionAtEnd = createReviewView(
      'prefix\nunchanged\nremoved\ntail',
      'prefix\nunchanged\ntail'
    ).view
    const beforeDeletion = deletionAtEnd.state.doc.line(2)
    const deletionChunks = chunksOf(deletionAtEnd)
    assert.equal(deletionChunks.length, 1)
    assert.equal(deletionChunks[0].fromB, deletionChunks[0].toB)
    assert.equal(
      rangeInPreviewSuppression(
        deletionAtEnd.state,
        beforeDeletion.from,
        deletionChunks[0].fromB
      ),
      false
    )
  })

  it('rebuilds preview renderers when a review arrives or clears without an edit', function () {
    // Reviews install and clear through compartment reconfiguration, which
    // changes no document, selection, or viewport — the renderer must still
    // rebuild, or widgets stay rendered over active chunks and hide their
    // controls (and stay raw after the review clears).
    const working = 'see [text](https://example.com) here\n'
    const reference = 'see [old](https://example.com) here\n'
    const reviewCompartment = new Compartment()
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: working,
        extensions: [ markdownParser(), renderLinks, reviewCompartment.of([]) ]
      })
    })
    views.push(view)
    const rawMarkers = (): boolean =>
      (view.contentDOM.textContent ?? '').includes('](https://example.com)')

    assert.equal(rawMarkers(), false, 'the link renders with hidden markers before a review exists')

    view.dispatch({
      effects: reviewCompartment.reconfigure(reviewChunksExtension({
        reviewId: 'review-renderer-rebuild',
        referenceText: reference,
        packets: [],
        chunkComments: [],
        onDecide: async () => {},
        onAcceptAll: async () => {},
        onClear: async () => {},
        onComment: async () => {},
        onChunkComment: async () => {}
      }))
    })
    assert.equal(
      rawMarkers(),
      true,
      'installing a review without an edit reveals the raw link under its chunk'
    )

    view.dispatch({ effects: reviewCompartment.reconfigure([]) })
    assert.equal(
      rawMarkers(),
      false,
      'clearing the review without an edit re-renders the link'
    )
  })

  it('navigates between chunks with next and previous, wrapping at both ends', function () {
    const baseline = [
      '# Note', '', 'first baseline', '', 'middle unchanged', '', 'second baseline', ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const { view } = createReviewView(baseline, proposed)
    const chunks = chunksOf(view)
    const anchorOf = (index: number): number =>
      view.state.doc.line(chunks[index].workFromLine).from

    assert.equal(selectNextReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(0))
    assert.equal(selectNextReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(1))
    assert.equal(selectNextReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(0))
    assert.equal(selectPreviousReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(1))
  })

  it('answers false from navigation commands outside a review', function () {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'plain text' })
    })
    views.push(view)
    assert.equal(selectNextReviewChunk(view), false)
    assert.equal(selectPreviousReviewChunk(view), false)
  })

  it('shows outstanding progress and emits mass actions without mutating local review state', async function () {
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const { view, calls } = createReviewView(baseline, proposed)
    const label = view.dom.querySelector<HTMLElement>('.cm-reviewStatusLabel')
    const acceptAll = view.dom.querySelector<HTMLButtonElement>('button.cm-reviewAcceptAll')
    const clear = view.dom.querySelector<HTMLButtonElement>('button.cm-reviewClear')
    assert.equal(label?.textContent, '2 outstanding')
    assert.ok(acceptAll !== null)
    assert.ok(clear !== null)

    // A mass action locks every control of the panel for its round trip, so
    // the second click here lands on a disabled button and does nothing. That
    // is the point: two sweeps must not be launched over one partition.
    acceptAll.click()
    assert.equal(acceptAll.disabled, true)
    assert.equal(clear.disabled, true)
    clear.click()
    assert.equal(calls.acceptAll, 1)
    assert.equal(calls.clear, 0)

    // Once it settles the controls come back, and the pane has still changed
    // nothing: only the provider's broadcast may do that.
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(acceptAll.disabled, false)
    clear.click()
    assert.equal(calls.clear, 1)
    assert.equal(chunksOf(view).length, 2)
    assert.equal(label?.textContent, '2 outstanding')
  })

  it('decides through the configuration on screen, not the one its widget was built with', async function () {
    // Every review mutation broadcasts a new session and the pane
    // reconfigures. A chunk nobody touched keeps its widget — CodeMirror
    // reuses one whose `eq` reports it unchanged — so a control closed over
    // the configuration it was BUILT with decides against a review state that
    // has since moved on. The generation the provider fences on lives in that
    // closure, and a click carrying the older one is refused.
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const built: DecisionCall[] = []
    const current: DecisionCall[] = []
    const configFor = (sink: DecisionCall[]): Parameters<typeof reviewChunksExtension>[0] => ({
      reviewId: 'review-test',
      referenceText: baseline,
      packets: [],
      chunkComments: [],
      onDecide: async (chunkId, decision) => {
        sink.push({ chunkId, decision })
      },
      onAcceptAll: async () => {},
      onClear: async () => {},
      onComment: async () => {},
      onChunkComment: async () => {}
    })
    const compartment = new Compartment()
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: proposed,
        extensions: [compartment.of(reviewChunksExtension(configFor(built)))]
      })
    })
    views.push(view)
    const chunks = chunksOf(view)
    const widgetBefore = view.dom.querySelector('.cm-chunkControls')

    view.dispatch({
      effects: compartment.reconfigure(reviewChunksExtension(configFor(current)))
    })
    assert.equal(
      view.dom.querySelector('.cm-chunkControls'),
      widgetBefore,
      'the untouched chunk must keep its widget, or this proves nothing'
    )

    view.dom.querySelector<HTMLButtonElement>('button.cm-review-diff-control.accept')?.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(current, [
      { chunkId: chunks[0].chunkId, decision: 'accept' }
    ])
    assert.deepEqual(built, [], 'the retired configuration must never be called')
  })

  it('carries the styling scope as an editor attribute owned by CodeMirror', function () {
    // The class used to be added by hand on view.dom, where CodeMirror's
    // attribute syncing wiped it on the next re-measure or focus change:
    // the controls kept working but dropped to unstyled buttons. Declared
    // as an editorAttributes facet, CodeMirror itself maintains it.
    const compartment = new Compartment()
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'proposal\n',
        extensions: [compartment.of(reviewChunksExtension({
          reviewId: 'review-test',
          referenceText: 'baseline\n',
          packets: [],
          chunkComments: [],
          onDecide: async () => {},
          onAcceptAll: async () => {},
          onClear: async () => {},
          onComment: async () => {},
          onChunkComment: async () => {}
        }))]
      })
    })
    views.push(view)
    assert.ok(
      view.dom.classList.contains('review-diff-active'),
      'mounting the review extension is what styles the pane'
    )
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    assert.ok(
      view.dom.classList.contains('review-diff-active'),
      'the class survives updates because CodeMirror owns it'
    )
    view.dispatch({ effects: compartment.reconfigure([]) })
    assert.equal(
      view.dom.classList.contains('review-diff-active'),
      false,
      'removing the review removes its styling scope with it'
    )
  })

  it('unmounts the status panel once nothing is outstanding', function () {
    // The provider's accept-echo moves the reference onto the working text:
    // the review survives, resolved and awaiting its save, but the panel is
    // chunk controls and must leave with the last chunk.
    const compartment = new Compartment()
    const configFor = (referenceText: string): Parameters<typeof reviewChunksExtension>[0] => ({
      reviewId: 'review-test',
      referenceText,
      packets: [],
      chunkComments: [],
      onDecide: async () => {},
      onAcceptAll: async () => {},
      onClear: async () => {},
      onComment: async () => {},
      onChunkComment: async () => {}
    })
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'proposal\n',
        extensions: [compartment.of(reviewChunksExtension(configFor('baseline\n')))]
      })
    })
    views.push(view)
    assert.ok(
      view.dom.querySelector('.cm-reviewStatusPanel') !== null,
      'an outstanding chunk mounts the panel'
    )

    view.dispatch({
      effects: compartment.reconfigure(reviewChunksExtension(configFor('proposal\n')))
    })
    assert.equal(
      view.dom.querySelector('.cm-reviewStatusPanel'),
      null,
      'a resolved review shows no bar of dead controls'
    )
  })

  it('lets a mass action end the review without an unhandled rejection', async function () {
    // Rejecting the last chunks ends the review, and the provider's broadcast
    // takes this extension out of the state. The panel's post-action render
    // then runs against a state carrying no review at all: reading the field
    // unconditionally threw "Field is not present in this state" out of a
    // promise nobody was holding, and in the running app that error covered
    // the window with the dev-server overlay and blocked every later click.
    const compartment = new Compartment()
    let cleared = 0
    let view: EditorView
    const extension = reviewChunksExtension({
      reviewId: 'review-test',
      referenceText: 'baseline\n',
      packets: [],
      chunkComments: [],
      onDecide: async () => {},
      onAcceptAll: async () => {},
      onClear: async () => {
        cleared += 1
        // What MainEditor does when the provider reports the review gone.
        view.dispatch({ effects: compartment.reconfigure([]) })
      },
      onComment: async () => {},
      onChunkComment: async () => {}
    })
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'proposal\n',
        extensions: [compartment.of(extension)]
      })
    })
    views.push(view)

    const rejections: unknown[] = []
    const collect = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', collect)
    view.dom.querySelector<HTMLButtonElement>('button.cm-reviewClear')?.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    process.off('unhandledRejection', collect)

    assert.equal(cleared, 1)
    assert.deepEqual(rejections, [], 'ending a review must raise nothing')
    assert.equal(
      view.dom.querySelector('.cm-reviewStatusPanel'),
      null,
      'the ended review takes its panel with it'
    )
  })

  it('emits trimmed review comments and never renders committed ones', function () {
    const { view, calls } = createReviewView('baseline', 'proposal')

    const input = view.dom.querySelector<HTMLInputElement>('.cm-reviewCommentInput')
    const submit = view.dom.querySelector<HTMLButtonElement>('.cm-reviewCommentSubmit')
    assert.ok(input !== null)
    assert.ok(submit !== null)
    input.value = '  overall note  '
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    submit.click()

    assert.deepEqual(calls.comments, ['overall note'])
    assert.equal(
      view.dom.querySelector('.cm-reviewComment'),
      null,
      'committed comments are the agent\'s data: the panel never lists them'
    )
  })

  it('returns no preview suppression outside an active review', function () {
    const doc = ['intro paragraph', '', '$$', 'p_a(C) = 10', '$$', ''].join('\n')
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc })
    })
    views.push(view)
    assert.equal(
      rangeInPreviewSuppression(
        view.state,
        view.state.doc.line(3).from,
        view.state.doc.line(5).to
      ),
      false
    )
  })

  it('leaves unchanged document lines visible instead of folding them away', function () {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)
    const baseline = lines.join('\n')
    const proposed = lines
      .map(line => line === 'line 30' ? 'line 30 corrected' : line)
      .join('\n')
    const { view } = createReviewView(baseline, proposed)

    assert.equal(chunksOf(view).length, 1)
    assert.equal(view.dom.querySelectorAll('.cm-collapsedLines').length, 0)
  })
})
