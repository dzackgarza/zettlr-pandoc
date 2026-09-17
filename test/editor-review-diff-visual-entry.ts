import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import {
  getReviewChunks,
  reviewChunksExtension
} from 'source/common/modules/markdown-editor/plugins/review-chunks'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderTables } from 'source/common/modules/markdown-editor/table-editor'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'

declare global {
  interface Window {
    captureReady: Promise<void>
    reviewDiffVisualDiagnostics: () => {
      chunks: number
      /** Every element in the editor that could adjudicate: a button, an
       *  input, or the status panel the review UI used to mount. The
       *  structural gate expects zero of each (I4). */
      buttons: number
      inputs: number
      panels: number
      deletions: number
      insertions: number
      tableReviewIndicators: number
      tableReviewSuggestionCount: string|undefined
      contentClientWidth: number|undefined
      contentScrollWidth: number|undefined
    }
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

async function mount (): Promise<void> {
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
      buttons: view.dom.querySelectorAll('button').length,
      inputs: view.dom.querySelectorAll('input, textarea, select').length,
      panels: view.dom.querySelectorAll('.cm-panels').length,
      deletions: view.dom.querySelectorAll('del.cm-deletedText').length,
      insertions: view.dom.querySelectorAll('.cm-changedText').length,
      tableReviewIndicators: view.dom.querySelectorAll('.cm-table-review-indicator').length,
      tableReviewSuggestionCount: view.dom.querySelector<HTMLElement>('.cm-table-review-changed')?.dataset.reviewSuggestionCount,
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth
    }
  }

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
