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
import { statSync } from 'fs'
import path from 'path'
import os from 'os'

/**
 * True iff `target` resolves to a regular file, following symlinks — the
 * shared isFile helper uses lstat, which reports false for a symlinked
 * ~/.pandoc/justfile even though the recipe behind it is perfectly usable.
 */
function resolvesToFile (target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch (err) {
    return false
  }
}

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
  { command: 'biber', purpose: 'bibliography resolution for PDF export' }
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
 * (preflight() injects showError/exit the same way).
 */
export type VersionOutputRunner = (command: string, args: string[]) => Promise<{ code: number, stdout: string }>

/**
 * The pure comparison at the heart of the compatibility check: given the two
 * captured `--version` outputs, decides compatibility per the
 * CrossrefCompatibility contract above.
 *
 * @param   {string}  _crossrefVersionOutput  Captured `pandoc-crossref --version` stdout
 * @param   {string}  _pandocVersionOutput    Captured `pandoc --version` stdout
 *
 * @return  {CrossrefCompatibility}           The typed compatibility outcome
 */
export function assessCrossrefCompatibility (
  _crossrefVersionOutput: string,
  _pandocVersionOutput: string
): CrossrefCompatibility {
  // Phase 7 skeleton (issue #1): the real parsing/comparison is the green step.
  return { status: 'compatible' }
}

/**
 * Executes `pandoc-crossref --version` and `pandoc --version` through the
 * given runner and assesses their compatibility. The default runner spawns
 * the real tools (green step); tests inject a runner serving captured
 * outputs.
 *
 * @param   {VersionOutputRunner}  _run  The command runner (defaults to real execution)
 *
 * @return  {Promise<CrossrefCompatibility>}  The typed compatibility outcome
 */
export async function checkCrossrefCompatibility (
  _run?: VersionOutputRunner
): Promise<CrossrefCompatibility> {
  // Phase 7 skeleton (issue #1): the executing check is the green step.
  return { status: 'compatible' }
}

/**
 * The preflight-facing compatibility gate: resolves null when
 * pandoc-crossref executes and names the installed pandoc version, and
 * otherwise a human-readable failure message that names BOTH versions (the
 * one pandoc-crossref was built with and the installed pandoc). preflight()
 * treats a non-null result exactly like a missing requirement.
 *
 * @param   {VersionOutputRunner}  _run  The command runner (defaults to real execution)
 *
 * @return  {Promise<string|null>}       The failure message, or null
 */
export async function crossrefCompatibilityFailure (
  _run?: VersionOutputRunner
): Promise<string|null> {
  // Phase 7 skeleton (issue #1): the real gate is the green step.
  return null
}

/**
 * Runs the preflight. If anything is missing, reports it through `showError`,
 * calls `exit(1)`, and resolves false. Otherwise resolves true. The failure
 * side effects are injected so the whole path is testable without Electron.
 *
 * @param   showError  Presents a fatal message to the user (e.g. dialog box).
 * @param   exit       Terminates the process with the given code.
 */
export async function preflight (
  showError: (title: string, message: string) => void,
  exit: (code: number) => void,
  commands: CommandRequirement[] = REQUIRED_COMMANDS,
  paths: PathRequirement[] = requiredPaths()
): Promise<boolean> {
  const missing = await findMissingRequirements(commands, paths)
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
