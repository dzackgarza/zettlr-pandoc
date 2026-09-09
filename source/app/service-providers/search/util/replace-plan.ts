/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Replace plan
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure half of search and replace: from one document's
 *                  source and the match spans to replace, the workspace text
 *                  edits that do it and the edits that undo it, both as
 *                  CodeMirror computes them — the same ChangeSet the document
 *                  authority applies, inverted against the same text.
 *
 * END HEADER
 */

import { ChangeSet, Text } from '@codemirror/state'
import type { SourceRange, WorkspaceTextEdit } from '@dts/common/references'

export interface DocumentReplacePlan {
  /** The edits, in document order, non-overlapping. */
  edits: WorkspaceTextEdit[]
  /** The edits that restore the source once `edits` have been applied. */
  inverse: WorkspaceTextEdit[]
  /** The text after the edits. */
  target: string
}

/**
 * Plans the replacement of the given spans of one document. Overlapping or
 * duplicate spans collapse to one edit over their union, so a span can never
 * be replaced twice; spans outside the document are refused.
 */
export function planDocumentReplace (documentPath: string, source: string, spans: readonly SourceRange[], replacement: string): DocumentReplacePlan {
  const sorted = [ ...spans ].sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: SourceRange[] = []
  for (const span of sorted) {
    if (span.from < 0 || span.to > source.length || span.from > span.to) {
      throw new RangeError(`Span ${span.from}-${span.to} lies outside ${documentPath} (${source.length} characters)`)
    }
    const last = merged[merged.length - 1]
    if (last !== undefined && span.from <= last.to) {
      last.to = Math.max(last.to, span.to)
    } else {
      merged.push({ from: span.from, to: span.to })
    }
  }

  const edits = merged.map(span => ({ documentPath, range: span, insert: replacement }))
  const changes = ChangeSet.of(edits.map(edit => ({ from: edit.range.from, to: edit.range.to, insert: edit.insert })), source.length)
  const before = Text.of(source.split('\n'))
  const inverted = changes.invert(before)
  const inverse: WorkspaceTextEdit[] = []
  inverted.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    inverse.push({ documentPath, range: { from: fromA, to: toA }, insert: inserted.toString() })
  })
  return { edits, inverse, target: changes.apply(before).toString() }
}
