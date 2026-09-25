import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderYamlFrontmatter } from 'source/common/modules/markdown-editor/renderers/render-yaml-frontmatter'
import { defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'

const doc = `---
title: Cursor mapping proof
tags:
  - moduli
  - compactification
author:
  - name: A. Author
    affiliation: NCTS
draft: false
---

# Body
Body text stays put.
`

interface YamlClickTarget {
  x: number
  y: number
  from: number
  to: number
}

interface YamlClickState {
  outerAnchor: number
  innerAnchor: number
  outerDoc: string
  innerDoc: string
}

declare global {
  interface Window {
    yamlClickReady: Promise<void>
    yamlClickTarget: (text: string) => YamlClickTarget
    yamlClickState: () => YamlClickState
    yamlClickReset: () => void
    yamlBodyTarget: () => { x: number, y: number }
    yamlOuterInitialAnchor: number
  }
}

async function mount (): Promise<void> {
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) throw new Error('Editor host is missing')
  const outerInitialAnchor = doc.length
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: outerInitialAnchor },
      extensions: [
        markdownParser(),
        EditorView.lineWrapping,
        editorTheme,
        defaultLight,
        configField,
        renderYamlFrontmatter
      ]
    }),
    parent: host
  })

  const nested = (): EditorView => {
    const root = document.querySelector<HTMLElement>('.yaml-frontmatter-editor .cm-editor')
    if (root === null) throw new Error('Nested YAML editor is missing')
    const found = EditorView.findFromDOM(root)
    if (found === null) throw new Error('Could not resolve nested YAML EditorView')
    return found
  }

  window.yamlOuterInitialAnchor = outerInitialAnchor
  window.yamlClickReset = () => {
    view.dispatch({ selection: { anchor: outerInitialAnchor } })
    const inner = nested()
    inner.dispatch({ selection: EditorSelection.cursor(0) })
  }
  window.yamlClickTarget = text => {
    const inner = nested()
    const source = inner.state.doc.toString()
    const from = source.indexOf(text)
    if (from < 0) throw new Error(`Missing YAML text target: ${text}`)
    const to = from + text.length
    const coords = inner.coordsAtPos(from + Math.floor(text.length / 2))
    if (coords === null) throw new Error(`No screen coordinates for YAML target: ${text}`)
    return {
      x: (coords.left + coords.right) / 2,
      y: (coords.top + coords.bottom) / 2,
      from,
      to
    }
  }
  window.yamlClickState = () => {
    const inner = nested()
    return {
      outerAnchor: view.state.selection.main.anchor,
      innerAnchor: inner.state.selection.main.anchor,
      outerDoc: view.state.doc.toString(),
      innerDoc: inner.state.doc.toString()
    }
  }
  window.yamlBodyTarget = () => {
    const lines = [ ...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line') ]
    const line = lines.find(candidate => candidate.textContent?.includes('Body text stays put.') === true)
    if (line === undefined) throw new Error('Could not find outer body click target')
    const rect = line.getBoundingClientRect()
    return { x: rect.left + Math.min(rect.width / 2, 80), y: rect.top + rect.height / 2 }
  }

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.yamlClickReady = mount()
