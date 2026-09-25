/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Line-number gutter width regression
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The gutter must remain a bounded navigation aid instead
 *                  of taking an unbounded share of the editor width.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { showLineNumbers } from 'source/common/modules/markdown-editor/plugins/line-numbers'

describe('line-number gutter sizing', function () {
  let view: EditorView|undefined

  before(function () {
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
    }
  })

  afterEach(function () {
    view?.destroy()
    view = undefined
    document.body.replaceChildren()
  })

  it('caps the line-number column instead of allowing content-driven gutter growth', function () {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'one\ntwo\nthree\n',
        extensions: showLineNumbers(true)
      })
    })

    const gutter = view.dom.querySelector<HTMLElement>('.cm-lineNumbers')
    assert.ok(gutter !== null)
    const style = getComputedStyle(gutter)
    const minWidth = Number.parseFloat(style.minWidth)
    const maxWidth = Number.parseFloat(style.maxWidth)
    assert.ok(Number.isFinite(minWidth) && minWidth > 0, `expected a positive gutter minimum, got ${style.minWidth}`)
    assert.ok(Number.isFinite(maxWidth) && maxWidth > minWidth, `expected a finite gutter ceiling, got ${style.maxWidth}`)
    assert.ok(maxWidth <= 64, `the line-number gutter ceiling must stay compact, got ${style.maxWidth}`)
    assert.equal(style.overflow, 'hidden')
  })
})
