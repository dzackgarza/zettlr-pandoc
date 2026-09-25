/**
 * Editor-neutral contract for external diagnostic providers.
 *
 * A provider receives plain source text plus caller-supplied context and
 * returns source-offset diagnostics. It knows nothing about CodeMirror.
 */

export type ExternalDiagnosticSeverity = 'hint' | 'info' | 'warning' | 'error'

export type ExternalDiagnosticAction =
  | {
      kind: 'replace'
      name: string
      replacement: string
      markClass?: string
    }
  | {
      kind: 'command'
      name: string
      command: string
      payload?: unknown
      markClass?: string
    }

export interface ExternalDiagnostic {
  from: number
  to: number
  severity: ExternalDiagnosticSeverity
  message: string
  source?: string
  markClass?: string
  data?: Record<string, unknown>
  actions?: readonly ExternalDiagnosticAction[]
}

export interface ExternalLintRequest<Context> {
  text: string
  context: Context
}

export interface ExternalLintResult<Metadata = undefined> {
  diagnostics: ExternalDiagnostic[]
  metadata?: Metadata
}

export interface ExternalLinter<Context = undefined, Metadata = undefined> {
  id: string
  run: (
    request: ExternalLintRequest<Context>
  ) => Promise<ExternalLintResult<Metadata>> | ExternalLintResult<Metadata>
}

export interface ExternalLinterRunRequest {
  id: string
  text: string
  context?: Record<string, unknown>
}

export interface ExternalLinterRunResponse {
  diagnostics: ExternalDiagnostic[]
  metadata?: Record<string, unknown>
}
