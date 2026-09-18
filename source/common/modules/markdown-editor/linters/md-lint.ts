/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown Linter
 * CVM-Role:        Linter
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Thin CodeMirror client of Flowmark's standalone,
 *                  Pandoc-aware linter.  Markdown parsing and lint semantics
 *                  live in the Flowmark submodule; this file only maps its
 *                  source coordinates into CodeMirror diagnostics.
 *
 * END HEADER
 */

import { linter, type Diagnostic } from '@codemirror/lint'
import type { Text } from '@codemirror/state'
import type {
  FlowmarkLintDiagnostic,
  FlowmarkLintResult
} from '@dts/common/flowmark-lint'

/** Convert a 1-based Flowmark line/column to a clamped CodeMirror offset. */
function sourceOffset (doc: Text, line: number, column: number): number {
  const lineNumber = Math.min(Math.max(Math.trunc(line), 1), doc.lines)
  const sourceLine = doc.line(lineNumber)
  return Math.min(
    sourceLine.to,
    sourceLine.from + Math.max(Math.trunc(column) - 1, 0)
  )
}

export function flowmarkDiagnosticToCodeMirror (
  diagnostic: FlowmarkLintDiagnostic,
  doc: Text
): Diagnostic {
  const from = sourceOffset(doc, diagnostic.line, diagnostic.column)
  const to = Math.max(
    from,
    sourceOffset(doc, diagnostic.end_line, diagnostic.end_column)
  )
  return {
    from,
    to,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: `flowmark (${diagnostic.rule})`
  }
}

export const mdLint = linter(async view => {
  const result: FlowmarkLintResult = await window.ipc.invoke('application', {
    command: 'lint-markdown',
    payload: view.state.doc.toString()
  })

  if (!result.ok) {
    return [{
      from: 0,
      to: Math.min(1, view.state.doc.length),
      severity: 'error',
      message: `Flowmark linter unavailable: ${result.message}`,
      source: 'flowmark-lint'
    }]
  }

  return result.diagnostics.map(diagnostic =>
    flowmarkDiagnosticToCodeMirror(diagnostic, view.state.doc)
  )
})
