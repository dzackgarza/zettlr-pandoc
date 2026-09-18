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
import type {
  FlowmarkLintDiagnostic,
  FlowmarkLintResult,
  FlowmarkLintSeverity
} from '@dts/common/flowmark-lint'

const FLOWMARK_LINT_TIMEOUT_MS = 60_000

export interface FlowmarkLintOptions {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

function severity (value: unknown): value is FlowmarkLintSeverity {
  return value === 'error' || value === 'warning'
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
    (candidate.replacement === undefined ||
      candidate.replacement === null ||
      typeof candidate.replacement === 'string')
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
  options: FlowmarkLintOptions = {}
): Promise<FlowmarkLintResult> {
  const result = await runFlowmarkProcess({
    command: options.command,
    argv: options.args ?? vendoredFlowmarkArgs(
      'flowmark-lint',
      [ '--format', 'json', '--exit-zero', '-' ]
    ),
    input: text,
    env: options.env,
    timeoutMs: options.timeoutMs ?? FLOWMARK_LINT_TIMEOUT_MS
  })
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
      message: 'Flowmark linter returned invalid JSON output.'
    }
  }

  return { ok: true, diagnostics: payload.files[0].diagnostics }
}
