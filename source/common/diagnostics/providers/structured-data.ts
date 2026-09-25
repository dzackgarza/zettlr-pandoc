import type {
  ExternalLinter
} from '@common/diagnostics/external-linter'
import YAML from 'yaml'
import {
  parse as parseJson,
  printParseErrorCode,
  type ParseError,
  type ParseErrorCode
} from 'jsonc-parser'

/**
 * Messages for jsonc-parser's error codes, worded as VS Code's JSON language
 * service words the same parse errors (vscode-json-languageservice,
 * src/parser/jsonParser.ts).
 */
const JSON_ERROR_MESSAGES: Record<ParseErrorCode, string> = {
  1: 'Invalid symbol.',
  2: 'Invalid number format.',
  3: 'Property expected.',
  4: 'Value expected.',
  5: 'Colon expected.',
  6: 'Expected comma.',
  7: 'Expected comma or closing brace.',
  8: 'Expected comma or closing bracket.',
  9: 'End of file expected.',
  10: 'Invalid comment token.',
  11: 'Unexpected end of comment.',
  12: 'Unexpected end of string.',
  13: 'Unexpected end of number.',
  14: 'Invalid unicode sequence in string.',
  15: 'Invalid escape character in string.',
  16: 'Invalid characters in string. Control characters must be escaped.'
}

export const yamlDiagnosticProvider: ExternalLinter = {
  id: 'yaml',
  run ({ text }) {
    // The editor already marks the error position, so skip the library's
    // line/column suffix and code frame.
    const document = YAML.parseDocument(text, { prettyErrors: false })
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
        message: JSON_ERROR_MESSAGES[error.error]
      }))
    }
  }
}

