import type { ExternalLinter } from '@common/diagnostics/external-linter'
import { ipcExternalLinter } from '@common/diagnostics/providers/ipc'

export interface FlowmarkDiagnosticContext extends Record<string, unknown> {
  sourcePath?: string
  citationKeys?: string[] | null
  projectRoots?: string[]
}

export const flowmarkDiagnosticProvider: ExternalLinter<FlowmarkDiagnosticContext> =
  ipcExternalLinter<FlowmarkDiagnosticContext, undefined>('flowmark')
