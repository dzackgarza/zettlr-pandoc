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

interface HoldView {
  chunkId: string
  comment?: string
}

interface CommentView {
  text: string
  createdAt: string
}

interface ReviewViewOptions {
  packets?: PacketView[]
  holds?: HoldView[]
  comments?: CommentView[]
}

interface DecisionCall {
  chunkId: string
  decision: 'accept'|'reject'|'hold'
  comment?: string
}

interface ReviewCalls {
  decisions: DecisionCall[]
  acceptAll: number
  clear: number
  comments: string[]
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
      comments: []
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
            holds: options.holds ?? [],
            comments: options.comments ?? [],
            onDecide: async (chunkId, decision, comment) => {
              calls.decisions.push({ chunkId, decision, comment })
            },
            onAcceptAll: async () => { calls.acceptAll += 1 },
            onClear: async () => { calls.clear += 1 },
            onComment: async (text) => { calls.comments.push(text) }
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
    const holds = view.dom.querySelectorAll<HTMLButtonElement>('button.cm-review-diff-control.hold')
    assert.equal(accepts.length, 2)
    assert.equal(rejects.length, 2)
    assert.equal(holds.length, 2)

    accepts[0].click()
    rejects[1].click()

    assert.deepEqual(calls.decisions, [
      { chunkId: chunks[0].chunkId, decision: 'accept', comment: undefined },
      { chunkId: chunks[1].chunkId, decision: 'reject', comment: undefined }
    ])
    assert.equal(
      chunksOf(view).length,
      2,
      'the view must not optimistically apply provider decisions'
    )
  })

  it('emits a trimmed hold note for the addressed chunk', function () {
    const { view, calls } = createReviewView('baseline\n', 'proposal\n')
    const chunk = chunksOf(view)[0]
    const input = view.dom.querySelector<HTMLInputElement>('input.cm-holdCommentInput')
    const hold = view.dom.querySelector<HTMLButtonElement>('button.cm-review-diff-control.hold')
    assert.ok(input !== null)
    assert.ok(hold !== null)

    input.value = '  check the constant  '
    hold.click()

    assert.deepEqual(calls.decisions, [
      { chunkId: chunk.chunkId, decision: 'hold', comment: 'check the constant' }
    ])
  })

  it('renders a provider-supplied hold distinctly without removing its controls', function () {
    const baseline = 'first baseline\n\nsecond baseline\n'
    const proposed = baseline.replace('first baseline', 'first proposed')
    const chunk = computeReviewChunks(baseline, proposed)[0]
    const { view } = createReviewView(baseline, proposed, {
      holds: [{ chunkId: chunk.chunkId, comment: 'check the constant' }]
    })

    const heldWidget = view.dom.querySelector<HTMLElement>('.cm-chunkControls.held')
    assert.ok(heldWidget !== null)
    assert.ok(heldWidget.textContent?.includes('Held: check the constant'))
    assert.ok(view.dom.querySelector('.cm-heldLine') !== null)
    assert.equal(
      heldWidget.querySelector<HTMLInputElement>('input.cm-holdCommentInput')?.value,
      'check the constant'
    )
    assert.ok(heldWidget.querySelector('button.accept') !== null)
    assert.ok(heldWidget.querySelector('button.reject') !== null)
    assert.ok(heldWidget.querySelector('button.hold') !== null)
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
    assert.ok(strips[0].querySelector('button.cm-review-diff-control.hold') !== null)
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
      holds: [],
      comments: [],
      onDecide: async (chunkId, decision, comment) => {
        sink.push({ chunkId, decision, comment })
      },
      onAcceptAll: async () => {},
      onClear: async () => {},
      onComment: async () => {}
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
      { chunkId: chunks[0].chunkId, decision: 'accept', comment: undefined }
    ])
    assert.deepEqual(built, [], 'the retired configuration must never be called')
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
      holds: [],
      comments: [],
      onDecide: async () => {},
      onAcceptAll: async () => {},
      onClear: async () => {
        cleared += 1
        // What MainEditor does when the provider reports the review gone.
        view.dispatch({ effects: compartment.reconfigure([]) })
      },
      onComment: async () => {}
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

  it('emits trimmed review comments and renders comments supplied by the provider', function () {
    const { view, calls } = createReviewView('baseline', 'proposal', {
      comments: [{ text: 'existing note', createdAt: '2026-08-04T00:00:00.000Z' }]
    })
    assert.equal(
      view.dom.querySelector<HTMLElement>('.cm-reviewComment')?.textContent,
      'existing note'
    )

    const input = view.dom.querySelector<HTMLInputElement>('.cm-reviewCommentInput')
    const submit = view.dom.querySelector<HTMLButtonElement>('.cm-reviewCommentSubmit')
    assert.ok(input !== null)
    assert.ok(submit !== null)
    input.value = '  overall note  '
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    submit.click()

    assert.deepEqual(calls.comments, ['overall note'])
    assert.equal(
      view.dom.querySelectorAll('.cm-reviewComment').length,
      1,
      'the view waits for the provider broadcast before adding the submitted comment'
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
