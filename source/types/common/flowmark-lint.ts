/**
 * Wire types emitted by the standalone Flowmark CLI and consumed by the
 * main-process Flowmark backend.
 */
export type FlowmarkLintSeverity = 'error' | 'warning' | 'info'

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
  data?: Record<string, unknown>
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
