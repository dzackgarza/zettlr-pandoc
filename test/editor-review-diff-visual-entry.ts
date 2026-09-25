import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import {
  getReviewChunks,
  reviewChunksExtension
} from 'source/common/modules/markdown-editor/plugins/review-chunks'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderTables } from 'source/common/modules/markdown-editor/table-editor'
import { configField, getDefaultConfig } from 'source/common/modules/markdown-editor/util/configuration'
import { renderers } from 'source/common/modules/markdown-editor/renderers'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import type { ReviewSuggestionView } from '@dts/common/review-diff'

declare global {
  interface Window {
    captureReady: Promise<void>
    reviewDiffVisualDiagnostics: () => {
      chunks: number
      deletions: number
      insertions: number
      tableReviewIndicators: number
      tableReviewSuggestionCount: string|undefined
      contentClientWidth: number|undefined
      contentScrollWidth: number|undefined
    }
    reviewRendererRegression: () => Promise<Array<{
      from: number
      to: number
      cmLines: number
      changed: number
      deleted: number
      contentHeight: number
      visibleRanges: Array<{ from: number, to: number }>
    }>>
  }
}

const baseline = [
  '# Review target',
  '',
  'The first paragraph keeps the original theorem statement.',
  '',
  'A long unchanged line keeps the panes honest without turning the review into a marketing scene.',
  '',
  'The second paragraph keeps the original proof sketch.',
  '',
  '| Object | Status |',
  '|--------|--------|',
  '| Table row | draft |',
  ''
].join('\n')

const proposed = baseline
  .replace('original theorem statement', 'revised theorem statement')
  .replace('original proof sketch', 'shorter proof sketch')
  .replace('| Table row | draft |', '| Table row | final |')

const rendererRegressionText = [
  '# Regression target {#sec:regression}',
  '',
  'The first proposed token appears here.',
  '',
  ':::{.theorem',
  '    title="A multiline authored title"',
  '    #thm:regression',
  '}',
  'The theorem body stays visible.',
  ':::',
  '',
  'A second proposed token appears after the multiline attribute block.',
  '',
  'A third proposed token is here.',
  '',
  'A fourth proposed token is here.',
  ''
].join('\n')

function rendererRegressionSuggestions (): ReviewSuggestionView[] {
  return [ 'first', 'second', 'third', 'fourth' ].map((token, index) => {
    const needle = `${token} proposed token`
    const from = rendererRegressionText.indexOf(needle)
    if (from < 0) {
      throw new Error(`Regression fixture token not found: ${needle}`)
    }
    return {
      suggestionId: `regression-${index + 1}`,
      removedText: `old-${token}`,
      anchors: [{ from, to: from + token.length }],
      seam: from,
      description: `Regression suggestion ${index + 1}`
    }
  })
}

async function mount (): Promise<void> {
  await initializeMathJax({})
  const theoremStart = proposed.indexOf('revised theorem statement')
  const proofStart = proposed.indexOf('shorter proof sketch')
  const tableStart = proposed.indexOf('final')
  const dark = document.body.dataset.dark === 'true'
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: proposed,
      extensions: [
        editorTheme,
        dark ? defaultDark : defaultLight,
        EditorView.lineWrapping,
        markdownParser(),
        configField,
        reviewChunksExtension({
          suggestions: [
            {
              suggestionId: 'suggestion-theorem',
              removedText: 'original theorem statement',
              anchors: [{ from: theoremStart, to: theoremStart + 'revised theorem statement'.length }],
              seam: theoremStart,
              description: 'Revise the theorem statement to match the corrected constant.'
            },
            {
              suggestionId: 'suggestion-proof',
              removedText: 'original proof sketch',
              anchors: [{ from: proofStart, to: proofStart + 'shorter proof sketch'.length }],
              seam: proofStart,
              description: 'Shorten the proof sketch.'
            },
            {
              suggestionId: 'suggestion-table',
              removedText: 'draft',
              anchors: [{ from: tableStart, to: tableStart + 'final'.length }],
              seam: tableStart,
              description: 'Update the rendered table row status.'
            }
          ]
        }),
        renderTables
      ]
    })
  })
  view.focus()

  window.reviewDiffVisualDiagnostics = () => {
    const chunks = getReviewChunks(view.state)
    const content = document.querySelector<HTMLElement>('.cm-content')
    return {
      chunks: chunks?.length ?? -1,
      deletions: view.dom.querySelectorAll('del.cm-deletedText').length,
      insertions: view.dom.querySelectorAll('.cm-changedText').length,
      tableReviewIndicators: view.dom.querySelectorAll('.cm-table-review-indicator').length,
      tableReviewSuggestionCount: view.dom.querySelector<HTMLElement>('.cm-table-review-changed')?.dataset.reviewSuggestionCount,
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth
    }
  }

  window.reviewRendererRegression = async () => {
    const fixture = {
      workingText: rendererRegressionText,
      suggestions: rendererRegressionSuggestions()
    }
    const regressionHost = document.createElement('div')
    regressionHost.style.position = 'fixed'
    regressionHost.style.left = '-10000px'
    regressionHost.style.top = '0'
    regressionHost.style.width = '1200px'
    regressionHost.style.height = '760px'
    document.body.appendChild(regressionHost)

    const config = getDefaultConfig()
    config.metadata.path = '/tmp/review-renderer-regression.md'
    const regressionView = new EditorView({
      parent: regressionHost,
      state: EditorState.create({
        doc: fixture.workingText,
        extensions: [
          editorTheme,
          defaultLight,
          EditorView.lineWrapping,
          markdownParser(),
          configField.init(() => config),
          renderers(config),
          reviewChunksExtension({ suggestions: fixture.suggestions })
        ]
      })
    })

    const snapshots: Array<{
      from: number
      to: number
      cmLines: number
      changed: number
      deleted: number
      contentHeight: number
      visibleRanges: Array<{ from: number, to: number }>
    }> = []
    try {
      for (const suggestion of fixture.suggestions.slice(0, 4)) {
        const anchor = suggestion.anchors[0] ?? { from: suggestion.seam, to: suggestion.seam }
        regressionView.dispatch({
          selection: { anchor: anchor.from, head: anchor.to },
          effects: EditorView.scrollIntoView(anchor.from, { y: 'center' })
        })
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        snapshots.push({
          from: anchor.from,
          to: anchor.to,
          cmLines: regressionView.contentDOM.querySelectorAll('.cm-line').length,
          changed: regressionView.contentDOM.querySelectorAll('.cm-changedText').length,
          deleted: regressionView.contentDOM.querySelectorAll('.cm-deletedText').length,
          contentHeight: regressionView.contentHeight,
          visibleRanges: regressionView.visibleRanges.map(range => ({ ...range }))
        })
      }
      return snapshots
    } finally {
      regressionView.destroy()
      regressionHost.remove()
    }
  }

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
