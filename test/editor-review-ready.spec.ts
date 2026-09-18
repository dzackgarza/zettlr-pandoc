/**
 * Review sessions may arrive while MarkdownEditor is still fetching its
 * authority document. They must become active as part of readiness itself,
 * not wait for an unrelated later document edit.
 */

import './provision-renderer-window-seams'
import { strict as assert } from 'assert'
import type { DocumentAuthorityAPI } from 'source/common/modules/markdown-editor'
import { DocumentType } from '@dts/common/documents'
import type { ReviewDiffSession } from '@dts/common/review-diff'

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

describe('MarkdownEditor review activation at readiness', function () {
  let MarkdownEditor: typeof import('source/common/modules/markdown-editor').default
  let previousCssLoader: ((module: NodeModule, filename: string) => void)|undefined

  before(async function () {
    polyfillJsdomForCodeMirror()
    const cjsRequire = require as NodeRequire & { extensions: Record<string, (module: NodeModule, filename: string) => void> }
    previousCssLoader = cjsRequire.extensions['.css']
    cjsRequire.extensions['.css'] = () => {}
    MarkdownEditor = (await import('source/common/modules/markdown-editor')).default
  })

  after(function () {
    const cjsRequire = require as NodeRequire & { extensions: Record<string, (module: NodeModule, filename: string) => void> }
    if (previousCssLoader === undefined) {
      delete cjsRequire.extensions['.css']
    } else {
      cjsRequire.extensions['.css'] = previousCssLoader
    }
  })

  it('activates a review received before the authority fetch resolves', async function () {
    const path = '/tmp/review-ready.md'
    const workingText = 'prefix PROPOSED suffix\n'
    let resolveFetch!: (value: { content: string, type: DocumentType, startVersion: number }) => void
    const fetch = new Promise<{ content: string, type: DocumentType, startVersion: number }>(resolve => {
      resolveFetch = resolve
    })
    const never = new Promise<never>(() => {})
    const authority: DocumentAuthorityAPI = {
      fetchDoc: async () => await fetch,
      pullUpdates: async () => await never,
      pushUpdates: async () => true
    }
    const editor = new MarkdownEditor('leaf', 'window', path, authority)
    const start = workingText.indexOf('PROPOSED')
    const review: ReviewDiffSession = {
      id: 'review-ready',
      reviewGeneration: 1,
      documentPath: path,
      workingText,
      suggestions: [{
        suggestionId: 'suggestion-ready',
        removedText: 'baseline',
        anchors: [{ from: start, to: start + 'PROPOSED'.length }],
        seam: start,
        description: 'Replace baseline wording.'
      }],
      chunkComments: []
    }

    editor.startReviewDiffSession(review)
    assert.equal(editor.instance.dom.classList.contains('review-diff-active'), false)

    resolveFetch({ content: workingText, type: DocumentType.Markdown, startVersion: 0 })
    await editor.ready

    assert.equal(editor.instance.state.doc.toString(), workingText)
    assert.equal(editor.instance.dom.classList.contains('review-diff-active'), true)
    assert.equal(editor.instance.dom.querySelectorAll('.cm-changedText').length, 1)
    assert.equal(editor.instance.dom.querySelectorAll('.cm-deletedText').length, 1)
    editor.unmount()
  })
})
