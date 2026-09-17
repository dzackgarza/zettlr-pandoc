/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        kitty launcher
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts a detached kitty in a directory, optionally running
 *                  one argv-safe command and holding its window afterwards.
 *
 * END HEADER
 */

import { spawn } from 'child_process'

export function kittyArguments (directory: string, command?: readonly string[]): string[] {
  const args = [ '--detach', '--directory', directory ]
  if (command !== undefined) {
    args.push('--hold', ...command)
  }
  return args
}

export async function launchKitty (directory: string, command?: readonly string[]): Promise<string> {
  return await new Promise(resolve => {
    const proc = spawn('kitty', kittyArguments(directory, command), {
      shell: false,
      stdio: 'ignore'
    })
    let resolved = false
    const finish = (message: string): void => {
      if (!resolved) {
        resolved = true
        resolve(message)
      }
    }
    proc.once('error', err => { finish(err.message) })
    proc.once('close', code => {
      finish(code === 0 ? '' : `kitty exited with status ${String(code)}`)
    })
  })
}

export function justRecipeCommand (
  repoRoot: string,
  recipe: string,
  args: readonly string[]
): string[] {
  return [ 'just', '--ceiling', repoRoot, '--one', recipe, ...args ]
}
