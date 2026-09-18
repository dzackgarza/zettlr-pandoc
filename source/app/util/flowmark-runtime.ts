/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        vendored Flowmark process runtime
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single main-process execution seam for the Flowmark
 *                  submodule.  Both formatting and linting run the exact
 *                  pinned source under vendor/flowmark (or its packaged
 *                  resources copy) through uvx.  Nothing in Zettlr owns a
 *                  Markdown grammar or fetches an unpinned Flowmark checkout.
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

const FLOWMARK_RUNNER = 'uvx'
const KILL_GRACE_MS = 2_000

/**
 * Locate the exact Flowmark project Zettlr owns as a git submodule.
 *
 * In a packaged app Electron Packager copies vendor/flowmark to
 * process.resourcesPath/flowmark.  During development/tests the checkout sits
 * at vendor/flowmark below the repository cwd.  The existence probe is what
 * distinguishes those two environments; process.resourcesPath also exists in
 * development Electron and therefore cannot be used as the distinction by
 * itself.
 */
export function vendoredFlowmarkProjectPath (): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath !== undefined) {
    const packaged = path.join(resourcesPath, 'flowmark')
    if (existsSync(path.join(packaged, 'pyproject.toml'))) {
      return packaged
    }
  }
  return path.resolve('vendor', 'flowmark')
}

/** uvx argv that installs/runs an entry point from the pinned local submodule. */
export function vendoredFlowmarkArgs (
  entrypoint: 'flowmark' | 'flowmark-lint',
  args: string[],
  projectPath = vendoredFlowmarkProjectPath()
): string[] {
  return [ '--from', projectPath, entrypoint, ...args ]
}

export interface FlowmarkProcessOptions {
  command?: string
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
  const command = options.command ?? FLOWMARK_RUNNER
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
          message: `Flowmark did not complete within ${String(options.timeoutMs)}ms and was terminated`
        })
      } else if (code === 0) {
        settle({ ok: true, stdout: stdout.join(''), stderr: stderr.join('') })
      } else {
        settle({
          ok: false,
          kind: 'flowmark-error',
          message: stderr.join('').trim() || `Flowmark exited with code ${String(code)}`
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
