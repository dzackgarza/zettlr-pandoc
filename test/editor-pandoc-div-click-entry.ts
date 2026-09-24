/** Mounts the production editor renderer for real Chromium click-position tests. */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderPandoc } from 'source/common/modules/markdown-editor/renderers/render-pandoc-div-span'
import { renderMath } from 'source/common/modules/markdown-editor/renderers/render-math'
import { defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'

const doc = `Before outside.

::: {.definition
  title="Compact multiline definition"
}
First target alpha.
Rendered math target \\(x+y\\).
Second target omega.
:::

Between outside.

::: warning
Third target gamma.
Fourth target delta.
:::

After outside target.
`

interface ClickTarget {
  x: number
  y: number
  expectedFrom: number
  expectedTo: number
  expectedAtCoords: number | null
  hitTag: string | null
  rectHeight?: number
}

declare global {
  interface Window {
    clickProbeReady: Promise<void>
    clickProbeReset: () => void
    clickProbeTarget: (text: string) => ClickTarget
    clickProbePanelGutterTarget: (text: string, side: 'left'|'right') => ClickTarget
    clickProbeLabelTarget: (label: string) => ClickTarget
    clickProbeWidgetTarget: (selector: string, source: string) => ClickTarget
    clickProbeAnchor: () => number
    clickProbeHead: () => number
  }
}

function findTextNode (text: string): { node: Text, from: number } {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.textContent ?? ''
    const from = value.indexOf(text)
    if (from >= 0 && node instanceof Text) {
      return { node, from }
    }
  }

  throw new Error(`Could not find visible editor text: ${text}`)
}

async function mount (): Promise<void> {
  await initializeMathJax({})
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Click-test editor host is missing')
  }

  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownParser(),
        EditorView.lineWrapping,
        editorTheme,
        defaultLight,
        renderPandoc,
        renderMath,
      ],
    }),
    parent: host,
  })

  window.clickProbeReset = () => {
    view.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true })
    view.focus()
  }
  window.clickProbeTarget = (text: string) => {
    const { node, from } = findTextNode(text)
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, from + text.length)
    const rect = range.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Visible editor text has no layout rectangle: ${text}`)
    }

    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return {
      x,
      y,
      expectedFrom: doc.indexOf(text),
      expectedTo: doc.indexOf(text) + text.length,
      expectedAtCoords: view.posAtCoords({ x, y }),
      hitTag: document.elementFromPoint(x, y)?.tagName ?? null,
    }
  }
  window.clickProbePanelGutterTarget = (text: string, side: 'left'|'right') => {
    const { node, from } = findTextNode(text)
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, from + text.length)
    const textRect = range.getBoundingClientRect()
    const panel = node.parentElement?.closest('pandoc-div-wrapper[data-pandoc-div-state="inactive"]')
    if (panel === null || panel === undefined) {
      throw new Error(`Could not find the inactive panel containing: ${text}`)
    }
    const panelRect = panel.getBoundingClientRect()
    if (textRect.height <= 0 || panelRect.width <= 0) {
      throw new Error(`Panel gutter target has no layout rectangle: ${text}`)
    }

    const x = side === 'left' ? panelRect.left + 5 : panelRect.right - 5
    const y = textRect.top + textRect.height / 2
    return {
      x,
      y,
      expectedFrom: doc.indexOf(text),
      expectedTo: doc.indexOf(text) + text.length,
      expectedAtCoords: view.posAtCoords({ x, y }),
      hitTag: document.elementFromPoint(x, y)?.tagName ?? null,
    }
  }
  window.clickProbeLabelTarget = (label: string) => {
    const element = document.querySelector<HTMLElement>(`pandoc-div-open-wrapper[data-pandoc-div-label="${label}"]`)
    if (element === null) {
      throw new Error(`Could not find semantic panel label: ${label}`)
    }
    const header = element.querySelector<HTMLElement>('.pandoc-div-header')
    if (header === null) {
      throw new Error(`Could not find rendered semantic header: ${label}`)
    }
    const rect = header.getBoundingClientRect()
    const x = rect.left + Math.min(rect.width / 2, 32)
    const y = rect.top + rect.height / 2
    const expectedFrom = Number(element.dataset.pandocDivFrom)
    return {
      x,
      y,
      expectedFrom,
      expectedTo: expectedFrom,
      expectedAtCoords: view.posAtCoords({ x, y }),
      hitTag: document.elementFromPoint(x, y)?.tagName ?? null,
      rectHeight: rect.height,
    }
  }
  window.clickProbeWidgetTarget = (selector: string, source: string) => {
    const element = document.querySelector<HTMLElement>(selector)
    if (element === null) {
      throw new Error(`Could not find rendered widget: ${selector}`)
    }
    const rect = element.getBoundingClientRect()
    const expectedFrom = doc.indexOf(source)
    if (expectedFrom < 0) {
      throw new Error(`Could not find widget source in document: ${source}`)
    }
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return {
      x,
      y,
      expectedFrom,
      expectedTo: expectedFrom + source.length,
      expectedAtCoords: view.posAtCoords({ x, y }),
      hitTag: document.elementFromPoint(x, y)?.tagName ?? null,
    }
  }
  window.clickProbeAnchor = () => view.state.selection.main.anchor
  window.clickProbeHead = () => view.state.selection.main.head

  view.focus()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.clickProbeReady = mount()
