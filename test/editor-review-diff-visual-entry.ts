import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import {
  getReviewChunks,
  reviewChunksExtension
} from 'source/common/modules/markdown-editor/plugins/review-chunks'

declare global {
  interface Window {
    captureReady: Promise<void>
    reviewDiffVisualDiagnostics: () => {
      chunks: number
      accepts: number
      rejects: number
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
  ''
].join('\n')

const proposed = baseline
  .replace('original theorem statement', 'revised theorem statement')
  .replace('original proof sketch', 'shorter proof sketch')

async function mount (): Promise<void> {
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
        reviewChunksExtension({
          reviewId: 'visual-capture',
          referenceText: baseline,
          packets: [],
          onDecide: () => { /* capture harness: decisions are not exercised */ }
        })
      ]
    })
  })
  view.dom.classList.add('review-diff-active')
  view.focus()

  window.reviewDiffVisualDiagnostics = () => {
    const chunks = getReviewChunks(view.state)
    const content = document.querySelector<HTMLElement>('.cm-content')
    return {
      chunks: chunks?.length ?? -1,
      accepts: document.querySelectorAll('button.cm-review-diff-control.accept').length,
      rejects: document.querySelectorAll('button.cm-review-diff-control.reject').length,
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth
    }
  }

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
