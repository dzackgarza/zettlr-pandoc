/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reattach-selection resolver specs (M10)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves the rule MainEditor.vue's beginAnnotationReattach
 *                  watcher enforces, over a real EditorView — the same
 *                  boundary annotation-context-menu.spec.ts proves
 *                  resolveAnnotateSelectionMenuItem against. S8/I6: an
 *                  orphaned anchor comes back to `range` ONLY through a
 *                  range the owner actually selected; a collapsed cursor
 *                  must refuse rather than fabricate a point.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { resolveReattachSelection } from 'source/win-main/util/annotation-reattach-selection'

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
    if (typeof w.window === 'object') { w.window.ResizeObserver = w.ResizeObserver }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) })
  }
}

const DOC = 'Something else entirely.\nWritten by another program.\n'

describe('Reattach-selection resolver (M10, S8/I6)', function () {
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

  function editorWithSelection (from: number, to: number): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, selection: { anchor: from, head: to } }),
      parent: document.body
    })
    views.push(view)
    return view
  }

  it('refuses a collapsed cursor rather than fabricating a point range (I6: no background guess)', function () {
    const cursor = DOC.indexOf('another program')
    const view = editorWithSelection(cursor, cursor)
    assert.deepEqual(resolveReattachSelection(view), { ok: false, reason: 'empty-selection' })
  })

  it('reports the exact range the owner selected, coordinate for coordinate', function () {
    const from = DOC.indexOf('another program')
    const to = from + 'another program'.length
    const view = editorWithSelection(from, to)
    assert.deepEqual(resolveReattachSelection(view), { ok: true, from, to })
  })
})
