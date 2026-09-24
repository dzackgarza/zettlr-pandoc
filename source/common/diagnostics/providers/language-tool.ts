import type { ExternalLinter } from '@common/diagnostics/external-linter'
import { ipcExternalLinter } from '@common/diagnostics/providers/ipc'
import type { LanguageToolIgnoredRuleEntry } from '@providers/config/get-config-template'

const userDictionary = new Set<string>()
let dictionaryListenerRegistered = false

export interface LanguageToolDiagnosticContext extends Record<string, unknown> {
  active: boolean
  language: string
  disabledRules: string[]
  supportedLanguages: string[]
  userDictionary: string[]
}

export interface LanguageToolDiagnosticMetadata {
  lastDetectedLanguage?: string
  supportedLanguages?: string[]
  lastError?: string
}

export interface DisableLanguageToolRulePayload {
  rule: LanguageToolIgnoredRuleEntry
  ruleId: string
}

export function languageToolUserDictionary (): string[] {
  return [...userDictionary]
}

function ensureDictionaryListener (): void {
  if (dictionaryListenerRegistered || window.ipc === undefined) {
    return
  }
  dictionaryListenerRegistered = true
  window.ipc.on('dictionary-provider', (_event, message) => {
    const payload = message as unknown as { command?: string }
    if (payload.command === 'invalidate-dict') {
      refreshLanguageToolUserDictionary()
    }
  })
}

export function refreshLanguageToolUserDictionary (): void {
  ensureDictionaryListener()
  if (window.ipc === undefined) {
    return
  }
  userDictionary.clear()
  window.ipc.invoke(
    'dictionary-provider',
    { command: 'get-user-dictionary' }
  ).then((dictionary: string[]) => {
    for (const word of dictionary) {
      userDictionary.add(word)
    }
  }).catch(() => {})
}

export const languageToolDiagnosticProvider: ExternalLinter<
LanguageToolDiagnosticContext,
LanguageToolDiagnosticMetadata
> = ipcExternalLinter<LanguageToolDiagnosticContext, LanguageToolDiagnosticMetadata>(
  'language-tool'
)
