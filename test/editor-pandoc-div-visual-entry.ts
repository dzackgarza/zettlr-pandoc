/** Mounts the production CodeMirror/Pandoc renderers for isolated visual capture. */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderEmphasis } from 'source/common/modules/markdown-editor/renderers/render-emphasis'
import { renderLinks } from 'source/common/modules/markdown-editor/renderers/render-links'
import { renderMath } from 'source/common/modules/markdown-editor/renderers/render-math'
import { renderPandoc } from 'source/common/modules/markdown-editor/renderers/render-pandoc-div-span'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'

declare global {
  interface Window {
    captureReady: Promise<void>
  }
}

const overview = `# Semantic fenced divs

::: theorem
Every compact interval has a maximum.
:::

::: definition
A *proper map* preserves compact inverse images, with $\\RR$ as a familiar setting.
:::

::: remark
The hypothesis matters at the boundary.
:::

::: problem
Find a counterexample when compactness is removed.
:::

::: warning
Do not silently replace local compactness by compactness.
:::

::: proof
Apply the finite-subcover argument.
:::

::: {.custom-result}
Project-specific metadata remains visibly generic.
:::
`

const nested = `# Nested structure

::: theorem
The outer result gives context without becoming a heavy box.

::: proof
The inner proof is progressively lighter and remains readable.
:::

The conclusion belongs to the outer theorem.
:::

Outside the structure.
`

const active = `# Editing state

::: {.definition #proper-map}
A *proper map* $f\\colon X\\to Y$ has [compact](https://example.com) inverse images.
:::

Outside the active div.
`

async function mount (): Promise<void> {
  await initializeMathJax({ RR: '\\mathbb{R}' })

  const scene = document.body.dataset.scene ?? 'overview'
  const dark = document.body.dataset.dark === 'true'
  const doc = scene === 'active' ? active : scene === 'nested' ? nested : overview
  const anchor = scene === 'active' ? doc.indexOf('*proper') + 2 : doc.length
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      markdownParser(),
      EditorView.lineWrapping,
      editorTheme,
      dark ? defaultDark : defaultLight,
      renderPandoc,
      renderEmphasis,
      renderLinks,
      renderMath,
    ],
  })

  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }

  const view = new EditorView({ state, parent: host })
  view.focus()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
