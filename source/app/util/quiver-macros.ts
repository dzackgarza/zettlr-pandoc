/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Quiver macro projection
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Projects the central ~/.pandoc MathJax derivative plus
 *                  the KaTeX-compatible subset of the actual TikZ template
 *                  graph into the vendored Quiver renderer. The template
 *                  graph has final precedence, matching TeX's include order;
 *                  Zettlr owns no independent macro semantics.
 *
 * END HEADER
 */

import type { MathJaxMacro } from '@common/util/mathjax-config'
import { tikzTemplateQuiverMacros } from './tikz-render'

export interface QuiverMacroProjection {
  /** KaTeX macro map. Keys include the leading backslash. */
  macros: Record<string, string>
  /** User macros whose semantics cannot be represented faithfully in KaTeX. */
  unsupported: string[]
}

/**
 * Start from the generated MathJax projection, then apply compatible definitions
 * from the actual TikZ template graph. dzg-tikz loads later TeX tiers specifically
 * to override MathJax-safe fallbacks, so reversing this precedence would make
 * Quiver disagree with the compiler.
 */
export function projectQuiverMacros (
  mathJaxMacros: Record<string, MathJaxMacro>,
  tikzTemplatePath: string
): QuiverMacroProjection {
  const macros: Record<string, string> = {}
  const unsupported = new Set<string>()

  for (const [name, definition] of Object.entries(mathJaxMacros).sort(([a], [b]) => a.localeCompare(b))) {
    const key = `\\${name}`
    if (typeof definition === 'string') {
      macros[key] = definition
      continue
    }

    const [body, _requiredArguments, optionalDefault] = definition
    if (optionalDefault !== undefined) {
      unsupported.add(key)
      continue
    }
    macros[key] = body
  }

  for (const [key, definition] of Object.entries(tikzTemplateQuiverMacros(tikzTemplatePath))) {
    macros[key] = definition
    unsupported.delete(key)
  }

  return {
    macros: Object.fromEntries(Object.entries(macros).sort(([a], [b]) => a.localeCompare(b))),
    unsupported: [...unsupported].sort((a, b) => a.localeCompare(b))
  }
}

export type QuiverMacrosIPCResponse = QuiverMacroProjection
