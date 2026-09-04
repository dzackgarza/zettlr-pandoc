/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Selection-anchored annotate command specs (M6)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the M6 structural-gate criterion "a context click
 *                  with no pre-existing selection does not offer the
 *                  command" — a criterion no screenshot can prove, since a
 *                  static capture of the OPEN composer says nothing about
 *                  what a click with no selection would have offered.
 *                  Drives resolveAnnotateSelectionMenuItem
 *                  (default-context-menu.ts) directly, over a real
 *                  EditorView: the exact function default-context-menu's
 *                  own contextmenu handler calls before the word-selection
 *                  fallback can turn an empty selection into a non-empty
 *                  one, so this is the boundary that decides whether the
 *                  command is offered, not a helper one step removed from
 *                  it. The second assertion identifies the resolved item by
 *                  the event its action dispatches (ANNOTATE_SELECTION_EVENT,
 *                  a plain exported string) rather than by its translated
 *                  label, which a locale change could alter without
 *                  touching the command's actual identity.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  ANNOTATE_SELECTION_EVENT,
  resolveAnnotateSelectionMenuItem
} from 'source/common/modules/markdown-editor/plugins/annotate-selection'

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

const DOC = 'Trust through transparency – make AI behavior understandable.\n'

describe('Selection-anchored annotate command (M6)', function () {
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
      state: EditorState.create({
        doc: DOC,
        selection: { anchor: from, head: to }
      }),
      parent: document.body
    })
    views.push(view)
    return view
  }

  it('offers no annotate item at a collapsed cursor inside a word', function () {
    const wordAt = DOC.indexOf('transparency') + 3 // inside "transparency", still a collapsed cursor
    const view = editorWithSelection(wordAt, wordAt)
    assert.equal(
      resolveAnnotateSelectionMenuItem(view),
      null,
      'a collapsed selection inside a word must not offer the annotate command'
    )
  })

  it('offers the annotate item over a real non-empty selection, identified by its dispatched event', function () {
    const from = DOC.indexOf('Trust through transparency')
    const to = from + 'Trust through transparency'.length
    const view = editorWithSelection(from, to)

    const item = resolveAnnotateSelectionMenuItem(view)
    assert.ok(item !== null, 'a non-empty selection must offer the annotate command')
    assert.equal(item.type, 'normal', 'the resolved item must be a normal (actionable) entry, not a separator')
    if (item.type !== 'normal') {
      return // Unreachable after the assertion above; narrows item.action for TS.
    }

    // The command's identity is the event its action dispatches, not its
    // (translatable) label — assert the real menu-item action fires the
    // real event with the real selection, on the view's own DOM.
    let firedDetail: { from: number, to: number }|null = null
    view.dom.addEventListener(ANNOTATE_SELECTION_EVENT, (event) => {
      firedDetail = (event as CustomEvent<{ from: number, to: number }>).detail
    })
    assert.ok(item.action !== undefined, 'the resolved item must carry an action')
    item.action()
    assert.deepEqual(firedDetail, { from, to }, 'the resolved item\'s action must dispatch ANNOTATE_SELECTION_EVENT with the exact selection')
  })
})
