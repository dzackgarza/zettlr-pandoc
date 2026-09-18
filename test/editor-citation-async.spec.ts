/**
 * Live citation rendering must never block CodeMirror on synchronous IPC.
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import {
  __resetCitationRenderMemoForTests,
  renderCitations
} from 'source/common/modules/markdown-editor/renderers/render-citations'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'

function codeMirrorDomPolyfills (): void {
  const globals = globalThis as typeof globalThis & {
    ResizeObserver?: typeof ResizeObserver
  }
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0) as unknown as number
    globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = globalThis.requestAnimationFrame
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame
  }
  if (typeof globals.ResizeObserver !== 'function') {
    globals.ResizeObserver = class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    }
    window.ResizeObserver = globals.ResizeObserver
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
    Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({})
    })
  }
}

async function nextTurn (): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('async citation widget rendering', function () {
  const originalIpc = window.ipc
  let view: EditorView|undefined

  before(function () {
    codeMirrorDomPolyfills()
  })

  afterEach(function () {
    view?.destroy()
    view = undefined
    document.body.replaceChildren()
    __resetCitationRenderMemoForTests()
    Object.defineProperty(window, 'ipc', { configurable: true, writable: true, value: originalIpc })
  })

  it('upgrades authored text asynchronously and reuses the memo after a remount', async function () {
    let invokes = 0
    const ipcDouble = {
      send: () => undefined,
      sendSync: () => undefined,
      on: () => () => undefined,
      invoke: async (channel: string, message: { command?: string }) => {
        if (channel === 'citeproc-provider' && message.command === 'get-citation') {
          invokes++
          return '(Olsson 2004)'
        }
        return undefined
      }
    }
    Object.defineProperty(window, 'ipc', { configurable: true, writable: true, value: ipcDouble })

    const doc = 'See [@Ols04] for details.\n'
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [ markdownParser(), configField, renderCitations ]
    })
    view = new EditorView({ state, parent: document.body })

    const initial = view.dom.querySelector<HTMLElement>('.citeproc-citation')
    assert.ok(initial !== null)
    assert.equal(initial.textContent, '[@Ols04]')
    assert.equal(initial.classList.contains('citeproc-pending'), true)

    await nextTurn()
    assert.equal(initial.textContent, '(Olsson 2004)')
    assert.equal(initial.classList.contains('citeproc-pending'), false)
    assert.equal(invokes, 1)

    view.dispatch({ selection: { anchor: doc.indexOf('@Ols04') + 2 } })
    assert.equal(view.dom.querySelector('.citeproc-citation'), null)
    view.dispatch({ selection: { anchor: doc.length } })
    await nextTurn()

    assert.equal(view.dom.querySelector('.citeproc-citation')?.textContent, '(Olsson 2004)')
    assert.equal(invokes, 1, 'a remounted identical citation must reuse the settled render promise')
  })
})
