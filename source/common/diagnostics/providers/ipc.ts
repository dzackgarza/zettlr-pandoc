import type {
  ExternalLinter,
  ExternalLinterRunResponse
} from '@common/diagnostics/external-linter'

export function ipcExternalLinter<
Context extends Record<string, unknown> = Record<string, unknown>,
Metadata = Record<string, unknown>
> (id: string): ExternalLinter<Context, Metadata> {
  return {
    id,
    async run ({ text, context }) {
      const result: ExternalLinterRunResponse = await window.ipc.invoke('application', {
        command: 'run-external-linter',
        payload: {
          id,
          text,
          context
        }
      })
      return {
        diagnostics: result.diagnostics,
        ...(result.metadata === undefined
          ? {}
          : { metadata: result.metadata as Metadata })
      }
    }
  }
}
