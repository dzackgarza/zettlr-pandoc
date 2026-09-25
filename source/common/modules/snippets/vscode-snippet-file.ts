/**
 * Parser/validator for the portable VS Code `.code-snippets` file format.
 *
 * Storage remains a standard external format. Zettlr owns only validation and
 * the projection into UserSnippet records consumed by the editor.
 */
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { SnippetFileDiagnostic, UserSnippet } from '@dts/common/snippets'

type UnknownRecord = Record<string, unknown>

function isRecord (value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList (value: unknown, field: string, snippetName: string): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    return value
  }
  throw new Error(`snippet "${snippetName}" has a non-string ${field}`)
}

function optionalStringList (value: unknown, field: string, snippetName: string): string[] {
  return value === undefined ? [] : stringList(value, field, snippetName)
}

function scopes (value: unknown, snippetName: string): string[] {
  if (value === undefined) {
    return []
  }
  if (typeof value !== 'string') {
    throw new Error(`snippet "${snippetName}" has a non-string scope`)
  }
  return value
    .split(',')
    .map(scope => scope.trim().toLowerCase())
    .filter(scope => scope !== '')
}

function bodyText (value: unknown, snippetName: string): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value) && value.every(line => typeof line === 'string')) {
    return value.join('\n')
  }
  throw new Error(`snippet "${snippetName}" has a body that is neither a string nor an array of strings`)
}

function description (value: unknown, snippetName: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`snippet "${snippetName}" has a non-string description`)
  }
  return value
}

function parseErrorMessage (errors: ParseError[]): string {
  return errors
    .map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
    .join(', ')
}

/** Parse one standard `.code-snippets` document. */
export function parseVSCodeSnippetFile (
  sourceFile: string,
  contents: string
): { snippets: UserSnippet[], diagnostics: SnippetFileDiagnostic[] } {
  const parseErrors: ParseError[] = []
  const parsed: unknown = parse(contents, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  })

  if (parseErrors.length > 0) {
    return {
      snippets: [],
      diagnostics: [{
        sourceFile,
        message: `Invalid JSONC: ${parseErrorMessage(parseErrors)}`
      }]
    }
  }

  if (!isRecord(parsed)) {
    return {
      snippets: [],
      diagnostics: [{ sourceFile, message: 'Snippet file root must be a JSON object.' }]
    }
  }

  const snippets: UserSnippet[] = []
  const diagnostics: SnippetFileDiagnostic[] = []

  for (const [name, candidate] of Object.entries(parsed)) {
    try {
      if (!isRecord(candidate)) {
        throw new Error(`snippet "${name}" must be a JSON object`)
      }

      const prefixes = stringList(candidate.prefix, 'prefix', name)
        .map(prefix => prefix.trim())
        .filter(prefix => prefix !== '')
      if (prefixes.length === 0) {
        throw new Error(`snippet "${name}" has no non-empty prefix`)
      }

      snippets.push({
        name,
        prefixes,
        body: bodyText(candidate.body, name),
        description: description(candidate.description, name),
        scopes: scopes(candidate.scope, name),
        include: optionalStringList(candidate.include, 'include', name),
        exclude: optionalStringList(candidate.exclude, 'exclude', name),
        sourceFile,
      })
    } catch (error) {
      diagnostics.push({
        sourceFile,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { snippets, diagnostics }
}

/** Refuse non-standard snippet storage at the boundary. */
export function isSnippetFileName (filename: string): boolean {
  return filename.toLowerCase().endsWith('.code-snippets')
}
