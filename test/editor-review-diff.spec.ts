/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor review-diff merge controls specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the issue #34 CodeMirror unified merge extension
 *                  used by MarkdownEditor: each changed chunk renders its own
 *                  Accept/Reject controls; accepting one chunk and rejecting
 *                  another leaves the document in the exact mixed state.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { getChunks } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { reviewDiffMergeExtension } from 'source/common/modules/markdown-editor/plugins/review-diff'
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

describe('Editor review-diff controls', function () {
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

  function createReviewView (baseline: string, proposed: string): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: proposed,
        extensions: [
          reviewDiffMergeExtension(baseline),
          EditorView.updateListener.of(() => {})
        ]
      })
    })
    views.push(view)
    return view
  }

  function chunkCount (view: EditorView): number {
    const chunks = getChunks(view.state)
    assert.ok(chunks !== null, 'the editor must be in unified merge mode')
    return chunks.chunks.length
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

    // getChunks returns null outside merge mode; the seam must answer false
    // rather than throw, or every renderer breaks when no review is open.
    assert.equal(
      rangeInPreviewSuppression(view.state, view.state.doc.line(3).from, view.state.doc.line(5).to),
      false
    )
  })

  it('leaves every unchanged line visible instead of folding them away', function () {
    // A review packet annotates the document the author is already reading, so
    // the surrounding text must survive untouched. `collapseUnchanged` replaces
    // runs of unchanged lines with a fold widget, which hides the rest of the
    // document to show a one-line correction.
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
