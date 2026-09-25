/**
 * Bracketed Pandoc spans share the same attribute grammar as fenced divs.
 * Nested braces inside quoted values must not terminate the attribute list.
 */

import './provision-renderer-window-seams'
import { strict as assert } from 'assert'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderPandoc } from 'source/common/modules/markdown-editor/renderers/render-pandoc-div-span'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'

function polyfillJsdomForCodeMirror (): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = callback => Number(setTimeout(() => callback(Date.now()), 0))
    globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = globalThis.requestAnimationFrame
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame
  }
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    }
    window.ResizeObserver = globalThis.ResizeObserver
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
    Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({})
    })
  }
}

describe('Pandoc bracketed-span attribute parsing', function () {
  before(function () {
    polyfillJsdomForCodeMirror()
  })

  it('preserves nested braces and escapes in quoted span attributes', function () {
    const doc = '[Marked]{.mark #span-core title="{\\cite[Thm. 1.1]{AEGS25}}"} outside'
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [ markdownParser(), configField, renderPandoc ]
      })
    })
    try {
      assert.ok(forceParsing(view, doc.length, 5000))
      const marked = view.dom.querySelector<HTMLElement>('#span-core.mark')
      assert.ok(marked !== null, `expected rendered Pandoc span: ${view.dom.innerHTML}`)
      assert.equal(marked.textContent, 'Marked')
      assert.equal(marked.getAttribute('title'), '{\\cite[Thm. 1.1]{AEGS25}}')
    } finally {
      view.destroy()
      document.body.replaceChildren()
    }
  })
})
