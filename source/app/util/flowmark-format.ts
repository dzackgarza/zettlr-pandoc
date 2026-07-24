/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        flowmark format service (issue #26)
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Formats markdown text with flowmark, the canonical formatter
 *                  across the toolchain (ai-review-ci runs it on every commit,
 *                  so formatting in-editor keeps the buffer matching what the
 *                  commit hook would produce). flowmark is a uvx external tool
 *                  that rewrites files in place, so this writes the text to a
 *                  temp file, runs `flowmark --inplace --semantic ...` over it,
 *                  and reads the result back. The tool being absent is a typed
 *                  result the caller surfaces, never a silent no-op. The runner
 *                  command is injectable so the roundtrip can be proven without
 *                  reaching for the network.
 *
 * END HEADER
 */

import { spawn } from 'child_process'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

/**
 * The typed outcome of a format attempt. `ok: false` is a real domain state,
 * not a swallowed error: `flowmark-absent` means the runner binary could not be
 * launched at all, `flowmark-error` means it ran but reported failure.
 */
export type FlowmarkResult =
  | { ok: true, formatted: string }
  | { ok: false, kind: 'flowmark-absent' | 'flowmark-error', message: string }

/** The canonical flowmark invocation (issue #26). */
const FLOWMARK_COMMAND = 'uvx'
const FLOWMARK_ARGS_PREFIX = [
  '--from', 'git+https://github.com/dzackgarza/flowmark.git',
  'flowmark',
  '--inplace', '--nobackup', '--semantic', '--no-respect-gitignore'
]

export interface FlowmarkOptions {
  /** The runner binary (default: `uvx`). Injected in tests. */
  command?: string
  /** Args placed before the temp-file path (default: the flowmark invocation). */
  argsPrefix?: string[]
  /** Environment for the child (default: the caller's `process.env`). */
  env?: NodeJS.ProcessEnv
}

interface RunOutcome {
  ok: boolean
  kind?: 'flowmark-absent' | 'flowmark-error'
  message: string
}

/** Runs the formatter process, distinguishing "could not launch" from "failed". */
async function runFormatter (command: string, argv: string[], env: NodeJS.ProcessEnv): Promise<RunOutcome> {
  return await new Promise<RunOutcome>((resolve) => {
    const stderr: string[] = []
    // shell: false — argv arrives literally, so a temp path with spaces is
    // never re-tokenized. The command itself is still PATH-resolved by spawn.
    const proc = spawn(command, argv, { env, shell: false })

    proc.stderr?.on('data', (data) => { stderr.push(String(data)) })

    // Fires when the binary itself cannot be launched (e.g. ENOENT): absent.
    proc.on('error', (err) => {
      resolve({ ok: false, kind: 'flowmark-absent', message: err.message })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, message: '' })
      } else {
        resolve({
          ok: false,
          kind: 'flowmark-error',
          message: stderr.join('').trim() || `flowmark exited with code ${String(code)}`
        })
      }
    })
  })
}

/**
 * Formats markdown `text` with flowmark and returns the result. On success the
 * returned `formatted` string is the rewritten temp file's bytes.
 *
 * @param   text  The markdown source to format.
 * @param   opts  Runner overrides (mainly for tests).
 *
 * @return        A typed FlowmarkResult.
 */
export async function formatMarkdownText (text: string, opts: FlowmarkOptions = {}): Promise<FlowmarkResult> {
  const command = opts.command ?? FLOWMARK_COMMAND
  const argsPrefix = opts.argsPrefix ?? FLOWMARK_ARGS_PREFIX
  const env = opts.env ?? process.env

  const dir = await mkdtemp(path.join(tmpdir(), 'zettlr-flowmark-'))
  const file = path.join(dir, 'document.md')

  try {
    await writeFile(file, text, 'utf-8')
    const outcome = await runFormatter(command, [ ...argsPrefix, file ], env)
    if (!outcome.ok) {
      return { ok: false, kind: outcome.kind ?? 'flowmark-error', message: outcome.message }
    }
    const formatted = await readFile(file, 'utf-8')
    return { ok: true, formatted }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
