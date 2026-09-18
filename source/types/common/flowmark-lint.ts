/**
 * The editor-neutral diagnostic contract emitted by the standalone Flowmark
 * linter and transported into renderer CodeMirror instances.
 */
export type FlowmarkLintSeverity = 'error' | 'warning'

export interface FlowmarkLintDiagnostic {
  rule: string
  severity: FlowmarkLintSeverity
  message: string
  /** 1-based source line/column coordinates. */
  line: number
  column: number
  end_line: number
  end_column: number
  replacement?: string | null
}

export interface FlowmarkLintRequest {
  text: string
  /** Real document path, when known, for relative-link/fragment validation. */
  sourcePath?: string
}

export type FlowmarkLintResult =
  | { ok: true, diagnostics: FlowmarkLintDiagnostic[] }
  | {
      ok: false
      kind:
        | 'flowmark-absent'
        | 'flowmark-error'
        | 'flowmark-timeout'
        | 'flowmark-invalid-output'
      message: string
    }
