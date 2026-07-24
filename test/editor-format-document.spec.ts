/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor "Format document" command contract (issue #26)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the editor-side contract of the flowmark "Format
 *                  document" command against a REAL CodeMirror EditorView with
 *                  a REAL undo history: the injected formatter's output is
 *                  applied to the buffer as a SINGLE undo step, the caret is
 *                  preserved across flowmark's whitespace-only reflow (anchored
 *                  to the same non-whitespace character it preceded), and a
 *                  typed formatter failure leaves the document byte-identical
 *                  rather than silently doing nothing. The formatter is
 *                  injected so this spec exercises the production transaction
 *                  path without reaching for uvx/flowmark or IPC; the
 *                  main-process service is proven separately.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, redo } from '@codemirror/commands'
import {
  formatDocument,
  type MarkdownFormatter
} from 'source/common/modules/markdown-editor/commands/format-document'

const views: EditorView[] = []

// CodeMirror's EditorView reads requestAnimationFrame off its own window (the
// element's ownerDocument.defaultView) to schedule a layout measure. The bare
// jsdom window in test/setup.js exposes no rAF there, and jsdom has no real
// layout (getClientRects), so a rAF that actually fired the measure would
// crash. Install an inert rAF: construction succeeds and doc/selection/undo
// state — which CodeMirror updates synchronously on dispatch — is unaffected.
const viewWindow = document.defaultView as unknown as {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (id: number) => void
}
if (typeof viewWindow.requestAnimationFrame !== 'function') {
  viewWindow.requestAnimationFrame = () => 1
  viewWindow.cancelAnimationFrame = () => { /* inert: no measure was scheduled */ }
}

function createEditor (doc: string, anchor = doc.length): EditorView {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [ history() ] })
  const view = new EditorView({ state, parent: document.body })
  views.push(view)
  return view
}

/** A formatter that returns fixed bytes, recording the input it received. */
function fixedFormatter (formatted: string): { fn: MarkdownFormatter, seen: string[] } {
  const seen: string[] = []
  const fn: MarkdownFormatter = async (text) => {
    seen.push(text)
    return { ok: true, formatted }
  }
  return { fn, seen }
}

describe('Editor "Format document" command (issue #26)', function () {
  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
  })

  it('feeds the whole current buffer to the formatter and applies its output', async function () {
    const doc = 'The cat sat.  The dog ran.\n'
    const formatted = 'The cat sat.\nThe dog ran.\n'
    const view = createEditor(doc)
    const { fn, seen } = fixedFormatter(formatted)

    const result = await formatDocument(view, fn)

    assert.deepEqual(seen, [ doc ], 'the formatter must receive exactly the current document text')
    assert.equal(result.ok, true)
    assert.equal(view.state.doc.toString(), formatted, 'the buffer must hold the formatted bytes')
  })

  it('applies the reformat as a SINGLE undo step that restores the original byte-identically', async function () {
    const doc = 'The cat sat.  The dog ran.\n'
    const formatted = 'The cat sat.\nThe dog ran.\n'
    const view = createEditor(doc)
    const { fn } = fixedFormatter(formatted)

    await formatDocument(view, fn)
    assert.equal(view.state.doc.toString(), formatted)

    assert.equal(undo(view), true, 'one undo must be available')
    assert.equal(view.state.doc.toString(), doc, 'a single undo must restore the original bytes exactly')
    // No SECOND undo of our making should exist (the format is one step).
    assert.equal(undo(view), false, 'the reformat must not have produced more than one undo step')

    assert.equal(redo(view), true)
    assert.equal(view.state.doc.toString(), formatted, 'redo must reapply the reformat')
  })

  it('preserves the caret across a whitespace-only reflow (anchored to the same word)', async function () {
    // Caret sits immediately before "dog" (a non-whitespace boundary).
    const doc = 'The cat sat.  The dog ran.\n'
    const caret = doc.indexOf('dog')
    const formatted = 'The cat sat.\nThe dog ran.\n'
    const view = createEditor(doc, caret)
    const { fn } = fixedFormatter(formatted)

    await formatDocument(view, fn)

    const newCaret = view.state.selection.main.head
    assert.equal(
      view.state.doc.sliceString(newCaret, newCaret + 3),
      'dog',
      'the caret must still sit immediately before the same word after reflow'
    )
  })

  it('leaves the document untouched and creates no undo step when the formatter reports it is absent', async function () {
    const doc = 'The cat sat.\n'
    const view = createEditor(doc)
    const absent: MarkdownFormatter = async () => ({ ok: false, kind: 'flowmark-absent', message: 'flowmark not found' })

    const result = await formatDocument(view, absent)

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.kind, 'flowmark-absent', 'the typed failure must be surfaced, not swallowed')
    }
    assert.equal(view.state.doc.toString(), doc, 'a failed format must not mutate the buffer')
    assert.equal(undo(view), false, 'a failed format must not push an undo step')
  })

  it('does not push an undo step when the formatted output is identical to the buffer', async function () {
    const doc = 'Already normalized.\n'
    const view = createEditor(doc)
    const { fn } = fixedFormatter(doc)

    const result = await formatDocument(view, fn)

    assert.equal(result.ok, true)
    assert.equal(view.state.doc.toString(), doc)
    assert.equal(undo(view), false, 'a no-op format must not pollute the undo history')
  })
})
