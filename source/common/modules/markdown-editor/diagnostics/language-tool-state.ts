/**
 * LanguageTool editor state and adapter hooks.
 *
 * Diagnostic semantics live in the external LanguageTool provider. This module
 * only keeps editor UI state and translates generic provider command/results.
 */

import { type Diagnostic } from '@codemirror/lint'
import { StateEffect, StateField, type Transaction } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { reportError } from '@common/util/error-reporting'
import extractYamlFrontmatter from 'source/common/util/extract-yaml-frontmatter'
import type { ExternalDiagnosticAction, ExternalLintResult } from '@common/diagnostics/external-linter'
import {
  refreshLanguageToolUserDictionary,
  languageToolUserDictionary,
  type DisableLanguageToolRulePayload,
  type LanguageToolDiagnosticContext,
  type LanguageToolDiagnosticMetadata
} from '@common/diagnostics/providers/language-tool'
import type {
  ExternalLinterPresentationConfig
} from './external-linter-adapter'
import { configField } from '../util/configuration'

const ipcRenderer = window.ipc

export function extractLTSpellcheckSuggestionsFrom (diag: Diagnostic): string[]|null {
  if (!isLanguageToolMisspelling(diag) || diag.actions === undefined) {
    return null
  }
  return diag.actions
    .filter(action => action.markClass === 'cm-ltSuggestAction')
    .map(action => action.name)
}

export function isLanguageToolMisspelling (diag: Diagnostic): boolean {
  return diag.source === 'language-tool(misspelling)'
}

export interface LanguageToolStateField {
  running: boolean
  lastDetectedLanguage: string
  supportedLanguages: string[]
  overrideLanguage: 'auto'|string
  lastError: string|undefined
  disabledRules: string[]
}

export const updateLTState = StateEffect.define<Partial<LanguageToolStateField>>()

export const languageToolState = StateField.define<LanguageToolStateField>({
  create: (state) => {
    refreshLanguageToolUserDictionary()
    let overrideLanguage = 'auto'
    const { frontmatter } = extractYamlFrontmatter(state.sliceDoc())
    if (typeof frontmatter?.lang === 'string' && /^[a-z]{2,3}(-[A-Z]{2,})?/.test(frontmatter.lang)) {
      overrideLanguage = frontmatter.lang
    }
    return {
      running: false,
      lastDetectedLanguage: 'auto',
      lastError: undefined,
      overrideLanguage,
      supportedLanguages: [],
      disabledRules: []
    }
  },
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(updateLTState)) {
        continue
      }
      value.running = effect.value.running ?? value.running
      value.lastDetectedLanguage = effect.value.lastDetectedLanguage ?? value.lastDetectedLanguage
      value.lastError = effect.value.lastError
      value.supportedLanguages = effect.value.supportedLanguages ?? value.supportedLanguages
      value.overrideLanguage = effect.value.overrideLanguage ?? value.overrideLanguage
      value.disabledRules = effect.value.disabledRules ?? value.disabledRules
    }
    return value
  }
})

function hideOn (transaction: Transaction): boolean | null {
  for (const effect of transaction.effects) {
    if (effect.is(updateLTState) && effect.value.disabledRules !== undefined) {
      return true
    }
  }
  return null
}

function needsRefresh (update: ViewUpdate): boolean {
  return update.transactions.some(transaction =>
    transaction.effects.some(effect =>
      effect.is(updateLTState) && effect.value.disabledRules !== undefined
    )
  )
}

export const languageToolLintConfig: ExternalLinterPresentationConfig = {
  delay: 2000,
  hideOn,
  needsRefresh
}

export function languageToolContext (view: EditorView): LanguageToolDiagnosticContext {
  const state = view.state.field(languageToolState)
  return {
    active: view.state.field(configField).lintLanguageTool,
    language: state.overrideLanguage,
    disabledRules: state.disabledRules,
    supportedLanguages: state.supportedLanguages,
    userDictionary: languageToolUserDictionary()
  }
}

export function languageToolRunStarted (view: EditorView): void {
  if (view.state.field(configField).lintLanguageTool) {
    view.dispatch({ effects: updateLTState.of({ running: true, lastError: undefined }) })
  }
}

export function languageToolRunFinished (
  view: EditorView,
  result: ExternalLintResult<LanguageToolDiagnosticMetadata>
): void {
  const metadata = result.metadata
  view.dispatch({
    effects: updateLTState.of({
      running: false,
      lastError: metadata?.lastError,
      lastDetectedLanguage: metadata?.lastDetectedLanguage,
      supportedLanguages: metadata?.supportedLanguages
    })
  })
}

export function languageToolCommand (
  view: EditorView,
  action: Extract<ExternalDiagnosticAction, { kind: 'command' }>
): void {
  if (action.command !== 'language-tool:disable-rule') {
    return
  }
  const payload = action.payload as DisableLanguageToolRulePayload
  ipcRenderer.invoke('application', {
    command: 'add-language-tool-ignore-rule',
    payload: payload.rule
  }).catch(err => reportError(err))

  const disabledRules = [...view.state.field(languageToolState).disabledRules]
  if (!disabledRules.includes(payload.ruleId)) {
    disabledRules.push(payload.ruleId)
  }
  view.dispatch({ effects: updateLTState.of({ disabledRules }) })
}

export const languageToolTheme = EditorView.theme({
  '.cm-diagnosticAction.cm-ltDisableAction': {
    backgroundColor: '#af5151'
  }
})
