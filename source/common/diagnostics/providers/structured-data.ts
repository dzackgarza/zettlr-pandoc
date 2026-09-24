import type {
  ExternalLinter
} from '@common/diagnostics/external-linter'
import YAML from 'yaml'
import {
  parse as parseJson,
  printParseErrorCode,
  type ParseError
} from 'jsonc-parser'

export const yamlDiagnosticProvider: ExternalLinter = {
  id: 'yaml',
  run ({ text }) {
    const document = YAML.parseDocument(text)
    return {
      diagnostics: document.errors.map(error => ({
        from: error.pos[0],
        to: error.pos[1],
        severity: 'error' as const,
        source: 'yaml(' + error.code + ')',
        message: error.message
      }))
    }
  }
}

export interface JsonDiagnosticContext {
  allowComments: boolean
  allowTrailingComma: boolean
}

export const jsonDiagnosticProvider: ExternalLinter<JsonDiagnosticContext> = {
  id: 'json',
  run ({ text, context }) {
    const errors: ParseError[] = []
    parseJson(text, errors, {
      allowTrailingComma: context.allowTrailingComma,
      disallowComments: !context.allowComments
    })
    return {
      diagnostics: errors.map(error => ({
        from: error.offset,
        to: error.offset + Math.max(error.length, 1),
        severity: 'error' as const,
        source: 'json(' + printParseErrorCode(error.error) + ')',
        message: printParseErrorCode(error.error)
      }))
    }
  }
}

