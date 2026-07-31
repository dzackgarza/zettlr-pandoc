/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor review-chunk controls specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the review-chunks plugin used by MarkdownEditor
 *                  through the real decision loop: each chunk renders its own
 *                  Accept/Reject controls; a click emits the chunk's
 *                  content-addressed id upward, a simulated provider applies
 *                  the decision with the same shared engine the real one
 *                  uses, and the pane redraws from the resulting state.
 *                  Accepting one chunk and rejecting another leaves the
 *                  document in the exact mixed state.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  getReviewChunks,
  reviewChunksExtension
} from 'source/common/modules/markdown-editor/plugins/review-chunks'
import {
  computeReviewChunks,
  spliceChunk
} from 'source/common/modules/review/review-chunks'
import { rangeInPreviewSuppression } from 'source/common/modules/markdown-editor/util/range-in-preview-suppression'

// jsdom does not ship the DOM APIs CodeMirror 6 uses for layout/scheduling.
// Polyfill the minimal set so an EditorView can mount and build decorations.
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
}

describe('Editor review-chunk controls', function () {
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

  /**
   * Mount a review view wired to a simulated provider that discharges the
   * production contract: resolve the clicked id against the shared engine's
   * partition, accept by moving the reference (and "re-broadcast" via a
   * compartment reconfigure), reject by editing the document. If the pane's
   * ids ever diverged from the provider's, the lookup here would fail —
   * partition agreement is part of what these tests certify.
   */
  function createReviewView (
    baseline: string,
    proposed: string,
    packets: Array<{ packetId: string, description?: string, refSpans: Array<{ from: number, to: number }> }> = []
  ): EditorView {
    const compartment = new Compartment()
    let reference = baseline
    let holds: Array<{ chunkId: string, comment?: string }> = []
    function makeExtension (): ReturnType<typeof reviewChunksExtension> {
      return reviewChunksExtension({
        reviewId: 'review-test',
        referenceText: reference,
        packets,
        holds,
        onDecide: (chunkId, decision, comment) => {
          const partition = computeReviewChunks(reference, view.state.doc.toString())
          const chunk = partition.find(c => c.chunkId === chunkId)
          assert.ok(chunk !== undefined, `provider has no chunk ${chunkId} — pane and provider partitions diverged`)
          // Deciding a held chunk releases its hold; holding upserts it —
          // the same contract the real store discharges.
          holds = holds.filter(h => h.chunkId !== chunkId)
          if (decision === 'accept') {
            reference = spliceChunk(reference, chunk, 'accept')
            view.dispatch({ effects: compartment.reconfigure(makeExtension()) })
          } else if (decision === 'reject') {
            const restored = spliceChunk(view.state.doc.toString(), chunk, 'reject')
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: restored }
            })
          } else {
            holds = [...holds, { chunkId, comment }]
            view.dispatch({ effects: compartment.reconfigure(makeExtension()) })
          }
        }
      })
    }
    const view: EditorView = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: proposed,
        extensions: [
          compartment.of(makeExtension()),
          EditorView.updateListener.of(() => {})
        ]
      })
    })
    views.push(view)
    return view
  }

  function chunkCount (view: EditorView): number {
    const chunks = getReviewChunks(view.state)
    assert.ok(chunks !== null, 'the editor must be in review mode')
    return chunks.length
  }

  it('accepts one chunk and rejects another into the exact mixed result', function () {
    const baseline = [
      '# Note',
      '',
      'first baseline',
      '',
      'middle unchanged',
      '',
      'second baseline',
      ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const expected = baseline
      .replace('first baseline', 'first proposed')

    const view = createReviewView(baseline, proposed)

    assert.equal(chunkCount(view), 2)
    const initialAcceptButtons = view.dom.querySelectorAll<HTMLButtonElement>('button.cm-review-diff-control.accept')
    const initialRejectButtons = view.dom.querySelectorAll<HTMLButtonElement>('button.cm-review-diff-control.reject')
    assert.equal(initialAcceptButtons.length, 2, 'each changed chunk must render an Accept control')
    assert.equal(initialRejectButtons.length, 2, 'each changed chunk must render a Reject control')

    initialAcceptButtons[0].click()
    assert.equal(chunkCount(view), 1, 'accepting the first chunk must resolve only that chunk')

    const remainingReject = view.dom.querySelector<HTMLButtonElement>('button.cm-review-diff-control.reject')
    assert.ok(remainingReject !== null, 'the remaining changed chunk must still render a Reject control')
    remainingReject.click()

    assert.equal(chunkCount(view), 0, 'rejecting the remaining chunk must finish the review')
    assert.equal(view.state.doc.toString(), expected)
  })

  it('holds a chunk from its control, carrying the typed note, and renders it distinct', function () {
    const baseline = [
      '# Note',
      '',
      'first baseline',
      '',
      'middle unchanged',
      '',
      'second baseline',
      ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')

    const view = createReviewView(baseline, proposed)
    assert.equal(chunkCount(view), 2)

    // Every chunk renders the third control with its note affordance.
    const holdButtons = view.dom.querySelectorAll<HTMLButtonElement>('button.cm-review-diff-control.hold')
    const noteInputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-holdCommentInput')
    assert.equal(holdButtons.length, 2, 'each chunk must render a Hold control')
    assert.equal(noteInputs.length, 2, 'each Hold control must carry a note field')

    noteInputs[0].value = '  check the constant  '
    holdButtons[0].click()

    // Holding adjudicates nothing: both chunks stay rendered, but the held
    // one is visually distinct and shows its (trimmed) note.
    assert.equal(chunkCount(view), 2, 'a held chunk must remain a rendered disagreement')
    const heldWidget = view.dom.querySelector<HTMLElement>('.cm-deletedChunk.held')
    assert.ok(heldWidget !== null, 'the held chunk must render visually distinct from pending')
    assert.equal(view.dom.querySelectorAll('.cm-deletedChunk.held').length, 1)
    assert.ok(
      heldWidget.textContent!.includes('Held: check the constant'),
      'the held chunk must show its note'
    )
    assert.ok(
      view.dom.querySelector('.cm-heldLine') !== null,
      'the held chunk lines must carry the held highlight, not the pending one'
    )
    const prefilled = heldWidget.querySelector<HTMLInputElement>('input.cm-holdCommentInput')
    assert.equal(prefilled?.value, 'check the constant', 'the note field must prefill for updating the hold')

    // A held chunk keeps all its controls: adjudicating it still works.
    const acceptOnHeld = heldWidget.querySelector<HTMLButtonElement>('button.cm-review-diff-control.accept')
    assert.ok(acceptOnHeld !== null, 'a held chunk must keep its Accept control')
    acceptOnHeld.click()
    assert.equal(chunkCount(view), 1, 'accepting the held chunk must resolve it')
    assert.equal(view.dom.querySelector('.cm-deletedChunk.held'), null)
  })

  it('shows each claim description at its own chunk controls, surviving a tweak', function () {
    const baseline = [
      '# Note',
      '',
      'first baseline',
      '',
      'middle unchanged',
      '',
      'second baseline',
      ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')

    // Attribution the way the provider records it: each claim's footprint is
    // the reference range of the chunk it produced.
    const partition = computeReviewChunks(baseline, proposed)
    assert.equal(partition.length, 2)
    const packets = [
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

    const view = createReviewView(baseline, proposed, packets)
    const widgets = [...view.dom.querySelectorAll<HTMLElement>('.cm-deletedChunk')]
    assert.equal(widgets.length, 2)
    const shown = widgets.map(widget =>
      [...widget.querySelectorAll('.cm-chunkDescription')].map(entry => entry.textContent)
    )
    assert.deepEqual(
      shown,
      [['Sharpen the opening claim'], ['Fix the closing claim']],
      'each chunk must carry exactly the description of the claim that produced it'
    )

    // A user tweak inside the first chunk recomputes the partition under a
    // new content-addressed id, but the label stays: user edits move working
    // positions, not the reference frame the attribution lives in.
    const firstChunk = getReviewChunks(view.state)![0]
    const insertAt = view.state.doc.line(firstChunk.workFromLine).to
    view.dispatch({ changes: { from: insertAt, to: insertAt, insert: ' (tweaked)' } })
    assert.equal(chunkCount(view), 2)
    const tweaked = view.dom.querySelector<HTMLElement>('.cm-deletedChunk .cm-chunkDescription')
    assert.equal(
      tweaked?.textContent,
      'Sharpen the opening claim',
      'the tweaked chunk must keep the description of the claim it grew from'
    )
  })

  it('shows the replaced reference text with the removed spans emphasised', function () {
    const baseline = ['alpha', '', 'the original wording stays here', ''].join('\n')
    const proposed = baseline.replace('original wording', 'revised wording')
    const view = createReviewView(baseline, proposed)

    const deleted = view.dom.querySelector<HTMLElement>('.cm-deletedChunk .cm-deletedLines')
    assert.ok(deleted !== null, 'a replacement chunk must show the reference lines it replaces')
    assert.ok(
      deleted.textContent!.includes('the original wording stays here'),
      'the widget must carry the full reference line'
    )
    // Word-level emphasis: the changed span is marked, unchanged words are not.
    const emphasised = deleted.querySelector<HTMLElement>('del.cm-deletedText')
    assert.ok(emphasised !== null, 'the removed span must be emphasised inside the reference line')
    assert.ok(emphasised.textContent!.includes('original'))
    assert.ok(!emphasised.textContent!.includes('stays'), 'unchanged words must not be emphasised')
  })

  it('suppresses live-preview rendering over a range carrying a review chunk', function () {
    // A renderer replaces its whole source range with a widget. A chunk landing
    // under one — a correction inside a $$…$$ block, say — takes the changed
    // line, the deleted text and the Accept/Reject controls out of the document
    // with it, so the review is invisible until the author clicks in and
    // un-renders the block by editing it.
    const baseline = [
      'intro paragraph',
      '',
      '$$',
      'p_a(C) = 10',
      '$$',
      '',
      'closing paragraph',
      ''
    ].join('\n')
    const proposed = baseline.replace('p_a(C) = 10', 'g(C) = 10')

    const view = createReviewView(baseline, proposed)
    assert.equal(chunkCount(view), 1)

    const mathFrom = view.state.doc.line(3).from
    const mathTo = view.state.doc.line(5).to
    assert.equal(
      rangeInPreviewSuppression(view.state, mathFrom, mathTo),
      true,
      'a renderer must leave the block raw while it carries an unresolved chunk'
    )

    // Prose the review does not touch keeps its rendering: this suppresses the
    // changed range, not the whole document.
    const introLine = view.state.doc.line(1)
    assert.equal(
      rangeInPreviewSuppression(view.state, introLine.from, introLine.to),
      false,
      'an untouched range must still render'
    )
  })

  it('renders normally once no review is active', function () {
    const doc = ['intro paragraph', '', '$$', 'p_a(C) = 10', '$$', ''].join('\n')
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc })
    })
    views.push(view)

    // getReviewChunks returns null outside review mode; the seam must answer
    // false rather than throw, or every renderer breaks when no review is open.
    assert.equal(
      rangeInPreviewSuppression(view.state, view.state.doc.line(3).from, view.state.doc.line(5).to),
      false
    )
  })

  it('leaves every unchanged line visible instead of folding them away', function () {
    // A review packet annotates the document the author is already reading, so
    // the surrounding text must survive untouched: no run of unchanged lines
    // may be folded into a widget to showcase a one-line correction.
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
    const baseline = lines.join('\n')
    const proposed = lines.map(line => line === 'line 30' ? 'line 30 corrected' : line).join('\n')

    const view = createReviewView(baseline, proposed)

    assert.equal(chunkCount(view), 1)
    assert.equal(
      view.dom.querySelectorAll('.cm-collapsedLines').length, 0,
      'no run of unchanged lines may be folded into a widget'
    )
  })
})
