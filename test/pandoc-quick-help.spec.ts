/**
 * Product-contract tests for the in-app Pandoc quick reference.
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import openPandocQuickHelp from 'source/app/service-providers/menu/open-pandoc-quick-help'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderCitations } from 'source/common/modules/markdown-editor/renderers/render-citations'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import {
  isSupportedPandocCrossref,
  PANDOC_ATTRIBUTE_EXAMPLES,
  PANDOC_CITATION_EXAMPLES,
  PANDOC_CROSS_REFERENCE_EXAMPLES,
  PANDOC_REFERENCE_MODIFIERS,
} from 'source/common/util/pandoc-quick-reference'

function polyfillJsdomForCodeMirror (): void {
  const global = globalThis as any
  if (typeof global.requestAnimationFrame !== 'function') {
    global.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    global.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof global.window === 'object' && typeof global.window.requestAnimationFrame !== 'function') {
    global.window.requestAnimationFrame = global.requestAnimationFrame
    global.window.cancelAnimationFrame = global.cancelAnimationFrame
  }
  if (typeof global.ResizeObserver !== 'function') {
    global.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    global.window.ResizeObserver = global.ResizeObserver
  }
  if (typeof global.Range?.prototype.getClientRects !== 'function') {
    global.Range.prototype.getClientRects = () => []
    global.Range.prototype.getBoundingClientRect = () => ({
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

describe('Pandoc quick reference', function () {
  before(function () {
    polyfillJsdomForCodeMirror()
  })

  afterEach(function () {
    document.body.replaceChildren()
  })

  it('opens in the focused editor window through the application shortcut channel', function () {
    const messages: Array<[string, string]> = []

    openPandocQuickHelp({
      webContents: {
        send: (channel, shortcut) => messages.push([ channel, shortcut ]),
      },
    })

    assert.deepStrictEqual(messages, [[ 'shortcut', 'pandoc-quick-help' ]])
  })

  it('documents the four cross-reference families rendered by the editor', function () {
    assert.deepStrictEqual(
      PANDOC_CROSS_REFERENCE_EXAMPLES.map(example => example.prefix),
      [ 'fig', 'tbl', 'eq', 'sec' ]
    )
    assert.equal(isSupportedPandocCrossref('tbl:comparison'), true)
    assert.equal(isSupportedPandocCrossref('tab:comparison'), false)
    assert.equal(isSupportedPandocCrossref('lst:algorithm'), false)
  })

  it('pairs every cross-reference label with the reference that cites it', function () {
    for (const example of PANDOC_CROSS_REFERENCE_EXAMPLES) {
      assert.match(example.label, new RegExp(`\\{#${example.prefix}:key\\}`))
      assert.equal(example.reference, `@${example.prefix}:key`)
    }
  })

  it('covers citation locators, prefixes, suffixes, groups, and author suppression', function () {
    const syntax = PANDOC_CITATION_EXAMPLES.map(example => example.syntax)

    assert.ok(syntax.includes('[@Ols04, pp. 7-9]'))
    assert.ok(syntax.includes('[see @Ols04, Lem. 7.1]'))
    assert.ok(syntax.includes('[see @Ols04; @AEGS23]'))
    assert.ok(syntax.includes('Smith argues this [-@Smith04].'))
  })

  it('covers grouped and modified references plus Pandoc block and inline attributes', function () {
    assert.deepStrictEqual(
      PANDOC_REFERENCE_MODIFIERS.map(example => example.syntax),
      [ '[@fig:first; @fig:second]', '[See @fig:key]', '[-@fig:key]' ]
    )
    assert.deepStrictEqual(
      PANDOC_ATTRIBUTE_EXAMPLES.map(example => example.kind),
      [ 'attributes', 'fenced-div', 'bracketed-span' ]
    )
  })

  it('renders the documented cross-reference prefix-suppression form', function () {
    const doc = 'See [-@fig:key].\n\noutside'
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [ markdownParser(), configField, renderCitations ],
    })
    const view = new EditorView({ state, parent: document.body })
    const rendered = view.dom.querySelector('.citeproc-citation')?.textContent

    assert.equal(rendered, '#key')
    view.destroy()
  })
})
