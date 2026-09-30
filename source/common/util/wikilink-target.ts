/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        splitWikilinkTarget
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The parts of a wikilink's target. This module imports
 *                  nothing: the renderer bundle maps Node's `path` to an
 *                  empty module, so the editor cannot import the resolver.
 *
 * END HEADER
 */

/**
 * Splits the text before a wikilink's `|` label into the document target and
 * the `#heading` fragment.
 */
export function splitWikilinkTarget (raw: string): { target: string, fragment: string|undefined } {
  const hash = raw.indexOf('#')
  if (hash < 0) {
    return { target: raw.trim(), fragment: undefined }
  }
  return { target: raw.slice(0, hash).trim(), fragment: raw.slice(hash + 1).trim() }
}
