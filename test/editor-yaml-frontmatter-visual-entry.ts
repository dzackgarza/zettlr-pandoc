import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderYamlFrontmatter } from 'source/common/modules/markdown-editor/renderers/render-yaml-frontmatter'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'

declare global {
  interface Window {
    captureReady: Promise<void>
  }
}

const doc = `---
title: KSBA compactifications of numerically polarized Enriques surfaces
author:
  - name: A. Author
    affiliation: National Center for Theoretical Sciences
tags:
  - moduli spaces
  - Enriques surfaces
  - compactifications
draft: false
bibliography:
  - references.bib
header-includes:
  - |
    \\usepackage{amsmath}
---

# Introduction

The document body begins here.
`

async function mount (): Promise<void> {
  const dark = document.body.dataset.dark === 'true'
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }
  new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownParser(),
        EditorView.lineWrapping,
        editorTheme,
        dark ? defaultDark : defaultLight,
        configField,
        renderYamlFrontmatter
      ]
    }),
    parent: host
  })
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
