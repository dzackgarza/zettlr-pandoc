/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        YAML front matter live-rendering tests
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * END HEADER
 */

import './provision-renderer-window-seams'
import { strict as assert } from 'assert'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderers } from 'source/common/modules/markdown-editor/renderers'
import { renderYamlFrontmatter } from 'source/common/modules/markdown-editor/renderers/render-yaml-frontmatter'
import { configField, getDefaultConfig } from 'source/common/modules/markdown-editor/util/configuration'

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
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({})
    })
  }
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('Editor renders YAML front matter as an interactive Properties editor', function () {
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

  function createEditor (doc: string, anchor = doc.length): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [ markdownParser(), renderYamlFrontmatter ]
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    views.push(view)
    return view
  }

  function nestedEditor (view: EditorView): EditorView {
    const editor = view.dom.querySelector<HTMLElement>('.yaml-frontmatter-editor .cm-editor')
    assert.ok(editor !== null, `expected nested YAML CodeMirror: ${view.dom.innerHTML}`)
    const nested = EditorView.findFromDOM(editor)
    assert.ok(nested !== null)
    return nested
  }

  const source = `---
title: Degenerations of Enriques surfaces
draft: false
tags:
  - moduli
  - K3
author:
  - name: A. Author
    affiliation: NCTS
abstract: |
  First line.
  Second line.
---

# Introduction
Body.`

  it('replaces inactive front matter with a nested YAML editor without changing Markdown', function () {
    const view = createEditor(source)
    const card = view.dom.querySelector('.yaml-frontmatter-card')
    assert.ok(card !== null, `expected rendered properties: ${view.dom.innerHTML}`)
    assert.equal(view.state.doc.toString(), source)
    assert.equal(card?.querySelector('.yaml-frontmatter-heading')?.textContent, 'Properties')
    assert.equal(card?.querySelector('.yaml-frontmatter-count')?.textContent, '5')

    const nested = nestedEditor(view)
    assert.match(nested.state.doc.toString(), /^title: Degenerations of Enriques surfaces/m)
    assert.match(nested.state.doc.toString(), /author:\n  - name: A\. Author\n    affiliation: NCTS/)
    assert.doesNotMatch(nested.state.doc.toString(), /^---$/m)
  })

  it('retains raw-source fallback when the outer selection explicitly enters the front matter', function () {
    const title = source.indexOf('Degenerations')
    const view = createEditor(source, title)
    assert.equal(view.dom.querySelector('.yaml-frontmatter-card'), null)
    assert.match(view.dom.textContent ?? '', /title: Degenerations of Enriques surfaces/)

    view.dispatch({ selection: { anchor: source.length } })
    assert.ok(view.dom.querySelector('.yaml-frontmatter-card') !== null)
    assert.equal(view.state.doc.toString(), source)
  })

  it('commits nested-editor changes back to only the YAML content range', async function () {
    const view = createEditor(source)
    const nested = nestedEditor(view)
    const beforeBody = view.state.sliceDoc(source.indexOf('# Introduction'))
    const oldTitle = 'Degenerations of Enriques surfaces'
    const from = nested.state.doc.toString().indexOf(oldTitle)
    nested.dispatch({ changes: { from, to: from + oldTitle.length, insert: 'KSBA compactifications' } })

    await sleep(350)

    assert.match(view.state.doc.toString(), /^---\ntitle: KSBA compactifications/m)
    assert.equal(view.state.sliceDoc(view.state.doc.toString().indexOf('# Introduction')), beforeBody)
    assert.ok(view.dom.querySelector('.yaml-frontmatter-card') !== null)
    assert.equal(nestedEditor(view), nested, 'committing must not tear down the focused nested editor')

    nested.dispatch({
      changes: {
        from: nested.state.doc.toString().indexOf('KSBA compactifications') + 'KSBA compactifications'.length,
        insert: ' of surfaces'
      }
    })
    await sleep(350)
    assert.match(view.state.doc.toString(), /^---\ntitle: KSBA compactifications of surfaces/m)
    assert.equal(nestedEditor(view), nested, 'successive commits must preserve the same nested editor instance')
  })

  it('keeps malformed YAML editable and marks its status instead of dropping the renderer', function () {
    const malformed = '---\ntitle: [unterminated\n---\n\nBody.'
    const view = createEditor(malformed)
    const card = view.dom.querySelector<HTMLElement>('.yaml-frontmatter-card')
    assert.ok(card !== null)
    assert.match(nestedEditor(view).state.doc.toString(), /unterminated/)
    assert.equal(card.querySelector('.yaml-frontmatter-status')?.textContent, 'Invalid YAML')
    assert.equal(card.classList.contains('yaml-frontmatter-invalid'), true)
  })

  it('supports YAML sequences without flattening or inventing property rows', function () {
    const sequence = '---\n- one\n- two\n---\n\nBody.'
    const view = createEditor(sequence)
    const card = view.dom.querySelector<HTMLElement>('.yaml-frontmatter-card')
    assert.ok(card !== null)
    assert.equal(card.querySelector('.yaml-frontmatter-count')?.textContent, 'YAML')
    assert.equal(nestedEditor(view).state.doc.toString(), '- one\n- two')
  })

  it('collapses the editor from the Properties header without exposing raw outer source', function () {
    const view = createEditor(source)
    const card = view.dom.querySelector<HTMLElement>('.yaml-frontmatter-card')
    const header = card?.querySelector<HTMLButtonElement>('.yaml-frontmatter-header')
    assert.ok(card !== null && header !== null)
    if (card === null || header == null) {
      throw new Error('expected rendered YAML Properties header')
    }

    header.click()
    assert.equal(card.classList.contains('yaml-frontmatter-collapsed'), true)
    assert.equal(header.getAttribute('aria-expanded'), 'false')
    assert.ok(view.dom.querySelector('.yaml-frontmatter-card') !== null)
    assert.equal(view.state.doc.toString(), source)
  })

  it('is part of preview mode and absent from raw mode in the production renderer aggregate', function () {
    const previewConfig = getDefaultConfig()
    previewConfig.renderingMode = 'preview'
    const previewState = EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        markdownParser(),
        configField.init(() => previewConfig),
        renderers(previewConfig)
      ]
    })
    const preview = new EditorView({ state: previewState, parent: document.body })
    assert.ok(forceParsing(preview, source.length, 5000))
    views.push(preview)
    assert.ok(preview.dom.querySelector('.yaml-frontmatter-card') !== null)

    const rawConfig = getDefaultConfig()
    rawConfig.renderingMode = 'raw'
    const rawState = EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        markdownParser(),
        configField.init(() => rawConfig),
        renderers(rawConfig)
      ]
    })
    const raw = new EditorView({ state: rawState, parent: document.body })
    assert.ok(forceParsing(raw, source.length, 5000))
    views.push(raw)
    assert.equal(raw.dom.querySelector('.yaml-frontmatter-card'), null)
    assert.match(raw.dom.textContent ?? '', /title: Degenerations of Enriques surfaces/)
  })
})
