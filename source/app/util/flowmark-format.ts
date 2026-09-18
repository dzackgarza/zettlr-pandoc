/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark format service
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Formats Markdown with the exact Flowmark source pinned as
 *                  vendor/flowmark.  The formatter and standalone linter share
 *                  flowmark-runtime.ts, so Zettlr has one Flowmark execution
 *                  boundary and never fetches an unpinned formatter checkout.
 *
 * END HEADER
 */

import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  runFlowmarkProcess,
  vendoredFlowmarkArgs,
  type FlowmarkProcessFailureKind
} from './flowmark-runtime'

export type FlowmarkResult =
  | { ok: true, formatted: string }
  | { ok: false, kind: FlowmarkProcessFailureKind, message: string }

const FLOWMARK_TIMEOUT_MS = 300_000

export interface FlowmarkOptions {
  /** Runner binary (default: uvx). Injected in tests. */
  command?: string
  /** Complete argv prefix placed before the temp-file path. */
  argsPrefix?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Formats Markdown `text` and returns the rewritten bytes.
 *
 * Flowmark's formatter works in-place, so this service owns the temporary
 * file.  The actual formatter source comes from the git submodule through
 * uvx's local `--from` path.
 */
export async function formatMarkdownText (
  text: string,
  opts: FlowmarkOptions = {}
): Promise<FlowmarkResult> {
  const argsPrefix = opts.argsPrefix ?? vendoredFlowmarkArgs(
    'flowmark',
    [ '--inplace', '--nobackup', '--semantic', '--no-respect-gitignore' ]
  )
  const dir = await mkdtemp(path.join(tmpdir(), 'zettlr-flowmark-'))
  const file = path.join(dir, 'document.md')

  try {
    await writeFile(file, text, 'utf-8')
    const outcome = await runFlowmarkProcess({
      command: opts.command,
      argv: [ ...argsPrefix, file ],
      env: opts.env,
      timeoutMs: opts.timeoutMs ?? FLOWMARK_TIMEOUT_MS
    })
    if (!outcome.ok) {
      return { ok: false, kind: outcome.kind, message: outcome.message }
    }
    return { ok: true, formatted: await readFile(file, 'utf-8') }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
