import { unifiedMergeView } from '@codemirror/merge'
import type { Extension } from '@codemirror/state'

export function reviewDiffMergeExtension (baselineText: string): Extension[] {
  return unifiedMergeView({
    original: baselineText,
    gutter: true,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
    allowInlineDiffs: false,
    mergeControls: renderReviewDiffControl,
    collapseUnchanged: {
      margin: 4,
      minSize: 8
    }
  })
}

function renderReviewDiffControl (type: 'reject'|'accept', action: (event: MouseEvent) => void): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.name = type
  button.className = `cm-review-diff-control ${type}`
  button.textContent = type === 'accept' ? 'Accept' : 'Reject'
  button.title = type === 'accept' ? 'Accept this change' : 'Reject this change'
  button.addEventListener('click', action)
  return button
}
