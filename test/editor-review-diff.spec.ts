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

function polyfillJsdomForCodeMirror (): void {
  const w = globalThis as any
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    w.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (typeof w.window === 'object') {
      w.window.ResizeObserver = w.ResizeObserver
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
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
})
