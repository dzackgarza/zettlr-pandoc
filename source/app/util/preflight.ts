/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        Utility function
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Startup preflight. Verifies that every external tool and file
 *                  the app hard-requires actually resolves in the app's runtime
 *                  environment (after fix-path), and fails loud and fast if any
 *                  is missing -- instead of surfacing a cryptic failure deep
 *                  inside an export. No fallbacks: a missing requirement stops
 *                  the app at boot.
 *
 * END HEADER
 */

import { spawn } from 'child_process'
import path from 'path'
import os from 'os'
// The FOLLOW-SYMLINKS variant (not @common/util/is-file, which lstats): a
// symlinked ~/.pandoc/justfile is perfectly usable and must pass preflight.
import resolvesToFile from '@common/util/resolves-to-file'

export interface CommandRequirement { command: string, purpose: string }
export interface PathRequirement { target: string, purpose: string }

/**
 * External commands this fork cannot function without. The PDF export pipeline
 * delegates to the ~/.pandoc `compile-pandoc` recipe, which shells out to pandoc,
 * latexmk, pdflatex, and biber; `just` runs the recipe itself.
 */
export const REQUIRED_COMMANDS: CommandRequirement[] = [
  { command: 'pandoc', purpose: 'document conversion for previews and every export' },
  { command: 'just', purpose: 'PDF export — runs the ~/.pandoc compile-pandoc recipe' },
  { command: 'latexmk', purpose: 'PDF build driver invoked by the compile-pandoc recipe' },
  { command: 'pdflatex', purpose: 'PDF typesetting engine used by the recipe' },
  { command: 'biber', purpose: 'bibliography resolution for PDF export' },
  { command: 'pandoc-crossref', purpose: 'cross-file reference resolution in the Project export filter chain' }
]

/**
 * Files that must exist on disk for core functionality.
 */
export function requiredPaths (): PathRequirement[] {
  return [
    {
      target: path.join(os.homedir(), '.pandoc', 'justfile'),
      purpose: 'the authoritative compile-pandoc PDF export recipe'
    }
  ]
}

/**
 * Resolves true iff `command` can be spawned (i.e. exists on PATH). Runs
 * `--version` with shell:false; an ENOENT 'error' event means it is not
 * installed. Any exit code counts as "present" — we only care that it resolves.
 */
export async function commandResolves (command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const proc = spawn(command, ['--version'], { shell: false })
    proc.on('error', () => resolve(false))
    proc.on('close', () => resolve(true))
  })
}

/**
 * Returns a human-readable list of every missing requirement (empty = all
 * present). Electron-free so it can be exercised directly in tests.
 */
export async function findMissingRequirements (
  commands: CommandRequirement[],
  paths: PathRequirement[]
): Promise<string[]> {
  const missing: string[] = []
  for (const { command, purpose } of commands) {
    if (!(await commandResolves(command))) {
      missing.push(`${command} — not found on PATH (needed for ${purpose})`)
    }
  }
  for (const { target, purpose } of paths) {
    if (!resolvesToFile(target)) {
      missing.push(`${target} — missing (${purpose})`)
    }
  }
  return missing
}

/**
 * The typed outcome of the pandoc-crossref <-> pandoc compatibility check
 * (issue #1 Phase 7).
 *
 * CONTRACT (locked red by test/preflight-crossref.spec.ts):
 *
 * - `crossrefBuiltWithPandoc` is the Pandoc version pandoc-crossref names in
 *   its own `--version` output ("… built with Pandoc vX.Y.Z …" -> 'X.Y.Z').
 * - `pandocVersion` is the version of the installed pandoc, parsed from the
 *   FIRST line of `pandoc --version` ('pandoc X.Y.Z' -> 'X.Y.Z').
 * - status 'compatible' iff both parse and are exactly equal; 'incompatible'
 *   iff both parse and differ; 'unparseable' when either output does not
 *   yield a version (that side's field stays undefined).
 */
export interface CrossrefCompatibility {
  status: 'compatible' | 'incompatible' | 'unparseable'
  crossrefBuiltWithPandoc?: string
  pandocVersion?: string
}

/**
 * Runs a command and captures its stdout — the injectable seam of the
 * compatibility check, following this module's existing injection style
 * (preflight() injects showError/exit the same way). The exit code is
 * deliberately NOT part of the contract (review B14): compatibility is
 * assessed purely from the version outputs, and a command that cannot run
 * yields an empty stdout, which assessCrossrefCompatibility already reports
 * loudly as 'unparseable'.
 */
export type VersionOutputRunner = (command: string, args: string[]) => Promise<{ stdout: string }>

/**
 * The pure comparison at the heart of the compatibility check: given the two
 * captured `--version` outputs, decides compatibility per the
 * CrossrefCompatibility contract above.
 *
 * @param   {string}  crossrefVersionOutput   Captured `pandoc-crossref --version` stdout
 * @param   {string}  pandocVersionOutput     Captured `pandoc --version` stdout
 *
 * @return  {CrossrefCompatibility}           The typed compatibility outcome
 */
export function assessCrossrefCompatibility (
  crossrefVersionOutput: string,
  pandocVersionOutput: string
): CrossrefCompatibility {
  const crossrefMatch = /built with Pandoc v(\d[\d.]*)/.exec(crossrefVersionOutput)
  const pandocMatch = /^pandoc(?:\.exe)?\s+(\d[\d.]*)/.exec(pandocVersionOutput.split('\n')[0])

  const crossrefBuiltWithPandoc = crossrefMatch?.[1]
  const pandocVersion = pandocMatch?.[1]

  if (crossrefBuiltWithPandoc === undefined || pandocVersion === undefined) {
    // A side that does not name its version cannot be assumed compatible.
    const unparseable: CrossrefCompatibility = { status: 'unparseable' }
    if (crossrefBuiltWithPandoc !== undefined) {
      unparseable.crossrefBuiltWithPandoc = crossrefBuiltWithPandoc
    }
    if (pandocVersion !== undefined) {
      unparseable.pandocVersion = pandocVersion
    }
    return unparseable
  }

  return {
    status: crossrefBuiltWithPandoc === pandocVersion ? 'compatible' : 'incompatible',
    crossrefBuiltWithPandoc,
    pandocVersion
  }
}

/**
 * The default VersionOutputRunner: spawns the real command (shell:false) and
 * captures its stdout. A command that cannot be spawned yields an empty
 * output, which assessCrossrefCompatibility reports as 'unparseable' — the
 * plain missing-command case is separately owned by REQUIRED_COMMANDS.
 */
const runVersionCommand: VersionOutputRunner = async (command, args) => {
  return await new Promise((resolve) => {
    const proc = spawn(command, args, { shell: false })
    let stdout = ''
    proc.stdout.on('data', (data) => { stdout += String(data) })
    proc.on('error', () => resolve({ stdout: '' }))
    proc.on('close', () => resolve({ stdout }))
  })
}

/**
 * Executes `pandoc-crossref --version` and `pandoc --version` through the
 * given runner and assesses their compatibility. The default runner spawns
 * the real tools; tests inject a runner serving captured outputs.
 *
 * @param   {VersionOutputRunner}  run  The command runner (defaults to real execution)
 *
 * @return  {Promise<CrossrefCompatibility>}  The typed compatibility outcome
 */
export async function checkCrossrefCompatibility (
  run: VersionOutputRunner = runVersionCommand
): Promise<CrossrefCompatibility> {
  const crossref = await run('pandoc-crossref', ['--version'])
  const pandoc = await run('pandoc', ['--version'])
  return assessCrossrefCompatibility(crossref.stdout, pandoc.stdout)
}

/**
 * The preflight-facing compatibility gate: resolves null when
 * pandoc-crossref executes and names the installed pandoc version, and
 * otherwise a human-readable failure message that names BOTH versions (the
 * one pandoc-crossref was built with and the installed pandoc). preflight()
 * treats a non-null result exactly like a missing requirement.
 *
 * @param   {VersionOutputRunner}  run  The command runner (defaults to real execution)
 *
 * @return  {Promise<string|null>}      The failure message, or null
 */
export async function crossrefCompatibilityFailure (
  run?: VersionOutputRunner
): Promise<string|null> {
  const result = await checkCrossrefCompatibility(run)

  if (result.status === 'compatible') {
    return null
  }

  if (result.status === 'incompatible') {
    return `pandoc-crossref — built with Pandoc v${result.crossrefBuiltWithPandoc ?? '?'}, ` +
      `but the installed pandoc is v${result.pandocVersion ?? '?'}; pandoc-crossref refuses ` +
      'mismatched pandoc builds, so Project exports would fail at runtime'
  }

  return 'pandoc-crossref — could not verify its pandoc build compatibility ' +
    `(pandoc-crossref names ${result.crossrefBuiltWithPandoc !== undefined ? `Pandoc v${result.crossrefBuiltWithPandoc}` : 'no Pandoc build version'}; ` +
    `pandoc reports ${result.pandocVersion !== undefined ? `v${result.pandocVersion}` : 'no version'})`
}

/**
 * Runs the preflight. If anything is missing, reports it through `showError`,
 * calls `exit(1)`, and resolves false. Otherwise resolves true. The failure
 * side effects are injected so the whole path is testable without Electron.
 * The pandoc-crossref <-> pandoc compatibility gate (issue #1 Phase 7) is
 * part of the preflight: a non-null crossrefCompatibilityFailure() is
 * reported exactly like a missing requirement.
 *
 * @param   showError       Presents a fatal message to the user (e.g. dialog box).
 * @param   exit            Terminates the process with the given code.
 * @param   commands        The required external commands.
 * @param   paths           The required on-disk files.
 * @param   crossrefFailure The compatibility gate (injected for testability).
 */
export async function preflight (
  showError: (title: string, message: string) => void,
  exit: (code: number) => void,
  commands: CommandRequirement[] = REQUIRED_COMMANDS,
  paths: PathRequirement[] = requiredPaths(),
  crossrefFailure: () => Promise<string|null> = crossrefCompatibilityFailure
): Promise<boolean> {
  const missing = await findMissingRequirements(commands, paths)
  const incompatibility = await crossrefFailure()
  if (incompatibility !== null) {
    missing.push(incompatibility)
  }
  if (missing.length === 0) {
    return true
  }

  const message = 'Zettlr-Pandoc cannot start — required tools or files are missing:\n\n' +
    missing.map(item => '  • ' + item).join('\n') +
    '\n\nInstall the missing dependencies (or fix the app\'s PATH), then relaunch.'
  showError('Zettlr-Pandoc — missing dependencies', message)
  exit(1)
  return false
}
