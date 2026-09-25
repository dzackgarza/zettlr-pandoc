/**
 * The only CodeMirror lint bridge.
 *
 * External linters return editor-neutral source diagnostics. This adapter maps
 * those diagnostics and their generic actions onto CodeMirror's presentation
 * surface. No lint rule semantics belong here.
 */

import {
  linter,
  type Action,
  type Diagnostic
} from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type {
  ExternalDiagnostic,
  ExternalDiagnosticAction,
  ExternalLintResult,
  ExternalLinter
} from '@common/diagnostics/external-linter'

export type ExternalLinterPresentationConfig =
  NonNullable<Parameters<typeof linter>[1]>

export interface ExternalLinterAdapter<Context, Metadata = undefined> {
  provider: ExternalLinter<Context, Metadata>
  context: (view: EditorView) => Context
  config?: ExternalLinterPresentationConfig
  onStart?: (view: EditorView) => void
  onResult?: (view: EditorView, result: ExternalLintResult<Metadata>) => void
  onCommand?: (
    view: EditorView,
    action: Extract<ExternalDiagnosticAction, { kind: 'command' }>
  ) => void
}

export interface ExternalLinterPlugin<Context, Metadata = undefined>
  extends ExternalLinterAdapter<Context, Metadata> {
  extensions?: readonly Extension[]
}

function actionToCodeMirror<Context, Metadata>(
  action: ExternalDiagnosticAction,
  adapter: ExternalLinterAdapter<Context, Metadata>
): Action {
  if (action.kind === 'replace') {
    return {
      name: action.name,
      markClass: action.markClass,
      apply (view, from, to) {
        view.dispatch({ changes: { from, to, insert: action.replacement } })
      }
    }
  }

  return {
    name: action.name,
    markClass: action.markClass,
    apply (view) {
      adapter.onCommand?.(view, action)
    }
  }
}

export function externalDiagnosticToCodeMirror<Context, Metadata>(
  diagnostic: ExternalDiagnostic,
  adapter: ExternalLinterAdapter<Context, Metadata>
): Diagnostic {
  return {
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    markClass: diagnostic.markClass,
    actions: diagnostic.actions?.map(action =>
      actionToCodeMirror(action, adapter)
    )
  }
}

export function externalLinterExtension<Context, Metadata = undefined>(
  adapter: ExternalLinterAdapter<Context, Metadata>
): Extension {
  return linter(async view => {
    adapter.onStart?.(view)
    const result = await adapter.provider.run({
      text: view.state.doc.toString(),
      context: adapter.context(view)
    })
    adapter.onResult?.(view, result)
    return result.diagnostics.map(diagnostic =>
      externalDiagnosticToCodeMirror(diagnostic, adapter)
    )
  }, adapter.config)
}

export function externalLinterPluginExtensions<Context, Metadata = undefined>(
  plugin: ExternalLinterPlugin<Context, Metadata>
): Extension[] {
  const lint = externalLinterExtension(plugin)
  // A plugin without presentation extensions contributes only its linter.
  if (plugin.extensions === undefined) {
    return [lint]
  }
  return [...plugin.extensions, lint]
}
