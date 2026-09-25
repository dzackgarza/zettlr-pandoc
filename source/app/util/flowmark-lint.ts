/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark lint service
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Runs the standalone linter from the pinned Flowmark
 *                  submodule and validates its JSON protocol.  Zettlr merely
 *                  transports diagnostics; parsing and lint semantics remain
 *                  owned by Flowmark.
 *
 * END HEADER
 */

import {
  runFlowmarkProcess,
  vendoredFlowmarkArgs,
  type FlowmarkProcessFailureKind
} from './flowmark-runtime'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import type {
  FlowmarkLintDiagnostic,
  FlowmarkLintResult,
  FlowmarkLintSeverity,
  FlowmarkLintSuggestion
} from '@dts/common/flowmark-lint'

export interface FlowmarkLintOptions {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  /** `editor.lint.flowmark.timeoutMs` from the app config. */
  timeoutMs: number
  /** Real document path used by Flowmark to resolve relative links. */
  sourcePath?: string
  /** JSON-serializable data Flowmark's rules read as lint context. */
  context?: Record<string, unknown>
}

function severity (value: unknown): value is FlowmarkLintSeverity {
  return value === 'error' || value === 'warning' || value === 'info'
}

function diagnostic (value: unknown): value is FlowmarkLintDiagnostic {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<FlowmarkLintDiagnostic>
  return typeof candidate.rule === 'string' &&
    severity(candidate.severity) &&
    typeof candidate.message === 'string' &&
    typeof candidate.line === 'number' &&
    typeof candidate.column === 'number' &&
    typeof candidate.end_line === 'number' &&
    typeof candidate.end_column === 'number' &&
    (candidate.data === undefined ||
      (typeof candidate.data === 'object' && candidate.data !== null && !Array.isArray(candidate.data))) &&
    Array.isArray(candidate.suggestions) &&
    candidate.suggestions.every(suggestion)
}

function suggestion (value: unknown): value is FlowmarkLintSuggestion {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<FlowmarkLintSuggestion>
  return typeof candidate.title === 'string' && typeof candidate.replacement === 'string'
}

interface FlowmarkLintWireFile {
  path: string
  diagnostics: FlowmarkLintDiagnostic[]
}

interface FlowmarkLintWirePayload {
  version: 1
  files: FlowmarkLintWireFile[]
}

function parseWirePayload (raw: string): FlowmarkLintWirePayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined
  }
  const payload = parsed as Partial<FlowmarkLintWirePayload>
  if (payload.version !== 1 || !Array.isArray(payload.files)) {
    return undefined
  }
  const files: FlowmarkLintWireFile[] = []
  for (const file of payload.files) {
    if (typeof file !== 'object' || file === null) {
      return undefined
    }
    const candidate = file as Partial<FlowmarkLintWireFile>
    if (typeof candidate.path !== 'string' ||
        !Array.isArray(candidate.diagnostics) ||
        !candidate.diagnostics.every(diagnostic)) {
      return undefined
    }
    files.push({
      path: candidate.path,
      diagnostics: candidate.diagnostics
    })
  }
  return { version: 1, files }
}

/**
 * Lint one unsaved editor buffer.  The document travels on stdin, so no temp
 * file or renderer-owned copy is involved.
 */
export async function lintMarkdownText (
  text: string,
  options: FlowmarkLintOptions
): Promise<FlowmarkLintResult> {
  const lintArgs = [ '--format', 'json', '--exit-zero' ]
  if (options.sourcePath !== undefined && options.sourcePath !== '') {
    lintArgs.push('--source-path', options.sourcePath)
  }
  let contextDirectory: string | undefined
  if (options.context !== undefined) {
    contextDirectory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-flowmark-lint-'))
    const contextPath = path.join(contextDirectory, 'context.json')
    await writeFile(contextPath, JSON.stringify(options.context), 'utf8')
    lintArgs.push('--context', contextPath)
  }
  lintArgs.push('-')

  let result
  try {
    result = await runFlowmarkProcess({
      command: options.command,
      argv: options.args ?? vendoredFlowmarkArgs(
        'flowmark-lint',
        lintArgs
      ),
      input: text,
      env: options.env,
      timeoutMs: options.timeoutMs
    })
  } finally {
    if (contextDirectory !== undefined) {
      await rm(contextDirectory, { recursive: true, force: true })
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind as FlowmarkProcessFailureKind,
      message: result.message
    }
  }

  const payload = parseWirePayload(result.stdout)
  if (payload === undefined ||
      payload.files.length !== 1 ||
      payload.files[0].path !== '-') {
    return {
      ok: false,
      kind: 'flowmark-invalid-output',
      message: 'Markdown linting returned invalid output.'
    }
  }

  return { ok: true, diagnostics: payload.files[0].diagnostics }
}
