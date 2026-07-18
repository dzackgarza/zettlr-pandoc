/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Math macro export projections
 * CVM-Role:        Utility
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Projects shared macro definitions into Pandoc header content.
 *
 * END HEADER
 */

export type MacroDefinition = string | readonly [body: string, requiredArguments: number] | readonly [body: string, requiredArguments: number, optionalDefault: string]
export type MacroConfig = Record<string, MacroDefinition>

function assertMacroDefinition (name: string, definition: unknown): asserts definition is MacroDefinition {
  const isString = typeof definition === 'string'
  const isRequiredArguments = Array.isArray(definition) && definition.length === 2 && typeof definition[0] === 'string' && Number.isInteger(definition[1]) && definition[1] > 0
  const isOptionalArguments = Array.isArray(definition) && definition.length === 3 && typeof definition[0] === 'string' && Number.isInteger(definition[1]) && definition[1] > 0 && typeof definition[2] === 'string'

  if (!isString && !isRequiredArguments && !isOptionalArguments) {
    throw new TypeError(`Unsupported macro definition for ${name}`)
  }
}

function sortedEntries (macros: Record<string, unknown>): Array<[string, MacroDefinition]> {
  return Object.entries(macros)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, definition]) => {
      assertMacroDefinition(name, definition)
      return [name, definition]
    })
}

/**
 * Produces a deterministic MathJax configuration script for Pandoc HTML headers.
 */
export function projectMathJaxHeader (macros: Record<string, unknown>): string {
  const config = Object.fromEntries(sortedEntries(macros))
  const json = JSON.stringify({ tex: { macros: config } }, null, 2)

  return `<script>\nwindow.MathJax = ${json};\n</script>`
}

/**
 * Produces deterministic TeX macro definitions for Pandoc TeX headers.
 */
export function projectTexHeader (macros: Record<string, unknown>): string {
  return sortedEntries(macros)
    .map(([name, definition]) => {
      if (typeof definition === 'string') {
        return `\\newcommand{\\${name}}{${definition}}`
      }

      const [body, requiredArguments, optionalDefault] = definition
      const optionalArguments = optionalDefault === undefined ? '' : `[${optionalDefault}]`
      return `\\newcommand{\\${name}}[${requiredArguments}]${optionalArguments}{${body}}`
    })
    .join('\n')
}
