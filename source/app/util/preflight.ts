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
    const proc = spawn(command, [ '--version' ], { shell: false })
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
