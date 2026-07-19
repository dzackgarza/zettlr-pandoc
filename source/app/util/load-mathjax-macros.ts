/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        User MathJax macro loader
 * CVM-Role:        Utility
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Loads the user's MathJax macro file from the app config
 *                  directory. The file uses the standard MathJax tex.macros
 *                  JSON shape, so any such export (e.g. a Pandoc macro export)
 *                  can be dropped in or symlinked to integrate a macro set.
 *
 * END HEADER
 */

import { promises as fs } from 'fs'
import path from 'path'
import isFile from '@common/util/is-file'
import { parseMathJaxMacros, type MathJaxMacro } from '@common/util/mathjax-config'

export const MATHJAX_MACROS_FILENAME = 'mathjax-macros.json'
export const MATHJAX_MACROS_EXAMPLE_FILENAME = 'mathjax-macros.json.example'

/**
 * Resolves the macro file inside the given config directory (the app's
 * userData directory, which is XDG-compliant on Linux).
 */
export function mathJaxMacrosPath (configDirectory: string): string {
  return path.join(configDirectory, MATHJAX_MACROS_FILENAME)
}

/**
 * Places a discoverable example macro file next to where the real one is read,
 * so a user browsing the config directory sees the expected filename and
 * format without any in-app UI. Copies the shipped example only if the user
 * has no example file yet, so a deleted example stays deleted.
 */
export async function ensureMacroExample (configDirectory: string, sourceExamplePath: string): Promise<void> {
  const target = path.join(configDirectory, MATHJAX_MACROS_EXAMPLE_FILENAME)
  if (isFile(target)) {
    return
  }

  await fs.copyFile(sourceExamplePath, target)
}

/**
 * Reads and validates the user's MathJax macro file. An absent file means the
 * user has no custom macros and yields an empty map; a present but malformed
 * file throws so the failure is visible rather than silently rendering without
 * the macros.
 */
export async function loadMathJaxMacros (filePath: string): Promise<Record<string, MathJaxMacro>> {
  if (!isFile(filePath)) {
    return {}
  }

  const contents = await fs.readFile(filePath, { encoding: 'utf8' })
  return parseMathJaxMacros(JSON.parse(contents))
}
