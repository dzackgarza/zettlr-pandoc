import { unifiedMergeView } from '@codemirror/merge'
import type { Extension } from '@codemirror/state'

export function reviewDiffMergeExtension (originalText: string): Extension[] {
  return unifiedMergeView({
    original: originalText,
    gutter: true,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
    allowInlineDiffs: false,
    mergeControls: renderReviewDiffControl
    // No `collapseUnchanged`: a review packet is an annotation on the document
    // the author is reading, not a diff view they navigated to. Folding the
    // untouched lines away rewrites the whole viewport to show a one-line
    // correction, which is what every other editor's inline accept/reject
    // deliberately avoids. Deletions and controls are additive decorations on
    // an otherwise untouched document.
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
