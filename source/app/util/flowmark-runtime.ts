/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark process runtime
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single main-process execution seam for Flowmark.
 *                  Formatting and linting run the `flowmark` and
 *                  `flowmark-lint` commands of the uv tool that the app
 *                  upgrades from Flowmark's main branch at every start
 *                  (flowmark-update.ts).  Nothing in Zettlr owns a Markdown
 *                  grammar.
 *
 * END HEADER
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

export type FlowmarkProcessFailureKind =
  | 'flowmark-absent'
  | 'flowmark-error'
  | 'flowmark-timeout'

export type FlowmarkProcessResult =
  | { ok: true, stdout: string, stderr: string }
  | { ok: false, kind: FlowmarkProcessFailureKind, message: string }

const KILL_GRACE_MS = 2_000

/** Locate a packaged/development external-linter process plugin. */
export function externalLinterPluginPath (filename: string): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath !== undefined) {
    const packaged = path.join(resourcesPath, 'linter-plugins', filename)
    if (existsSync(packaged)) {
      return packaged
    }
  }
  return path.resolve('linter-plugins', filename)
}

/**
 * The Python interpreter of the installed `flowmark` uv tool. A process
 * plugin that imports Flowmark (LanguageTool's) runs under it, so it sees the
 * same Flowmark as the `flowmark` and `flowmark-lint` commands.
 */
export async function flowmarkToolPython (): Promise<string> {
  const outcome = await runFlowmarkProcess({
    command: 'uv',
    argv: [ 'tool', 'dir' ],
    timeoutMs: 30_000
  })
  if (!outcome.ok) {
    throw new Error(`Cannot locate the uv tool directory: ${outcome.message}`)
  }
  return path.join(outcome.stdout.trim(), 'flowmark', 'bin', 'python')
}

export interface FlowmarkProcessOptions {
  command: string
  argv: string[]
  input?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
}

/**
 * Run one Flowmark process with bounded lifetime and captured stdio.
 *
 * The process is always spawned without a shell.  On timeout it receives
 * SIGTERM, then SIGKILL after a short grace, and the promise resolves only
 * after the child has actually closed.
 */
export async function runFlowmarkProcess (
  options: FlowmarkProcessOptions
): Promise<FlowmarkProcessResult> {
  const command = options.command
  const env = options.env ?? process.env

  return await new Promise<FlowmarkProcessResult>((resolve) => {
    const stdout: string[] = []
    const stderr: string[] = []
    const proc = spawn(command, options.argv, { env, shell: false })

    let settled = false
    let timedOut = false
    let boundTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const settle = (outcome: FlowmarkProcessResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (boundTimer !== undefined) {
        clearTimeout(boundTimer)
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer)
      }
      resolve(outcome)
    }

    proc.stdout?.on('data', data => { stdout.push(String(data)) })
    proc.stderr?.on('data', data => { stderr.push(String(data)) })
    proc.on('error', err => {
      settle({ ok: false, kind: 'flowmark-absent', message: err.message })
    })
    proc.on('close', code => {
      if (timedOut) {
        settle({
          ok: false,
          kind: 'flowmark-timeout',
          message: `Markdown processing did not complete within ${String(options.timeoutMs)} ms`
        })
      } else if (code === 0) {
        settle({ ok: true, stdout: stdout.join(''), stderr: stderr.join('') })
      } else {
        settle({
          ok: false,
          kind: 'flowmark-error',
          message: stderr.join('').trim() || `Markdown processing failed with exit code ${String(code)}`
        })
      }
    })

    if (options.input !== undefined) {
      proc.stdin?.end(options.input)
    } else {
      proc.stdin?.end()
    }

    boundTimer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      graceTimer = setTimeout(() => {
        proc.kill('SIGKILL')
      }, KILL_GRACE_MS)
    }, options.timeoutMs)
  })
}
