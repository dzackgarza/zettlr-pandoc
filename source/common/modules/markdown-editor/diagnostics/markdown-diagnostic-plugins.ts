import type { Extension } from '@codemirror/state'
import { citekeyUpdate } from '../autocomplete/citations'
import { workspaceReferencesField } from '../plugins/workspace-references-field'
import { configField } from '../util/configuration'
import { flowmarkDiagnosticProvider } from '@common/diagnostics/providers/flowmark'
import { spellcheckDiagnosticProvider } from '@common/diagnostics/providers/spellcheck'
import { languageToolDiagnosticProvider } from '@common/diagnostics/providers/language-tool'
import {
  languageToolCommand,
  languageToolContext,
  languageToolLintConfig,
  languageToolRunFinished,
  languageToolRunStarted,
  languageToolState,
  languageToolTheme
} from './language-tool-state'
import {
  externalLinterPluginExtensions,
  type ExternalLinterPlugin
} from './external-linter-adapter'

type AnyDiagnosticPlugin = ExternalLinterPlugin<any, any>

const MARKDOWN_DIAGNOSTIC_PLUGINS = new Map<string, AnyDiagnosticPlugin>()

export function registerMarkdownDiagnosticPlugin (
  plugin: AnyDiagnosticPlugin
): void {
  const id = plugin.provider.id
  if (MARKDOWN_DIAGNOSTIC_PLUGINS.has(id)) {
    throw new Error('Markdown diagnostic provider already registered: ' + id)
  }
  MARKDOWN_DIAGNOSTIC_PLUGINS.set(id, plugin)
}

registerMarkdownDiagnosticPlugin({
    provider: flowmarkDiagnosticProvider,
    context: view => {
      const config = view.state.field(configField, false)
      const references = view.state.field(workspaceReferencesField, false)
      return {
        sourcePath: config?.metadata.path || undefined,
        projectRoots: references?.projectRoots?.map(root => root.rootPath) ?? []
      }
    },
    // Flowmark reads the bibliography files itself. MainEditor dispatches
    // citekeyUpdate whenever citeproc reports a bibliography change, so that
    // is when the missing-citation check has new input.
    config: {
      needsRefresh: update => update.transactions.some(transaction =>
        transaction.effects.some(effect => effect.is(citekeyUpdate)))
    }
  })

registerMarkdownDiagnosticPlugin({
    provider: spellcheckDiagnosticProvider,
    context: view => ({
      autocorrectValues: view.state
        .field(configField)
        .autocorrect.replacements.map(item => item.value)
    })
  })

registerMarkdownDiagnosticPlugin({
    provider: languageToolDiagnosticProvider,
    context: languageToolContext,
    onStart: languageToolRunStarted,
    onResult: languageToolRunFinished,
    onCommand: languageToolCommand,
    config: languageToolLintConfig,
    extensions: [languageToolState, languageToolTheme]
  })

export function markdownDiagnosticExtensions (): Extension[] {
  return [...MARKDOWN_DIAGNOSTIC_PLUGINS.values()].flatMap(plugin =>
    externalLinterPluginExtensions(plugin)
  )
}

export function registeredMarkdownDiagnosticProviders (): string[] {
  return [...MARKDOWN_DIAGNOSTIC_PLUGINS.keys()].sort()
}
