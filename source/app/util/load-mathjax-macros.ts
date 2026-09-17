/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Canonical MathJax macro loader
 * CVM-Role:        Utility
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Loads the generated MathJax projection owned by the central
 *                  ~/.pandoc macro system. Production consumers must resolve
 *                  that projection from ~/.pandoc; the generic file loader is
 *                  retained only for explicit tests/fixtures.
 *
 * END HEADER
 */

import { promises as fs } from 'fs'
import path from 'path'
import isFile from '@common/util/is-file'
import { parseMathJaxMacros, type MathJaxMacro } from '@common/util/mathjax-config'

export const MATHJAX_MACROS_FILENAME = 'mathjax-macros.json'

/** Resolve the generated MathJax projection owned by ~/.pandoc. */
export function canonicalMathJaxMacrosPath (homeDirectory: string): string {
  return path.join(homeDirectory, '.pandoc', 'templates', 'css', MATHJAX_MACROS_FILENAME)
}

/**
 * Load the central generated projection. Missing central configuration is a
 * configuration error: production must never fall back to a bundled/app-local
 * macro copy, because that creates a second semantic authority.
 */
export async function loadCanonicalMathJaxMacros (homeDirectory: string): Promise<Record<string, MathJaxMacro>> {
  const filePath = canonicalMathJaxMacrosPath(homeDirectory)
  if (!isFile(filePath)) {
    throw new Error(
      `MathJax macros require the central generated projection ${filePath}; ` +
      'run ~/.pandoc/bin/generate-mathjax-config.py from the canonical macro tree.'
    )
  }
  return await loadMathJaxMacros(filePath)
}

/**
 * Reads and validates one explicit MathJax macro projection. Production uses
 * this only through `loadCanonicalMathJaxMacros`; accepting an arbitrary path
 * here is useful for isolated fixtures and projection tests. An absent explicit
 * fixture yields an empty map, while malformed content fails loudly.
 */
export async function loadMathJaxMacros (filePath: string): Promise<Record<string, MathJaxMacro>> {
  if (!isFile(filePath)) {
    return {}
  }

  const contents = await fs.readFile(filePath, { encoding: 'utf8' })
  return parseMathJaxMacros(JSON.parse(contents))
}
