/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MathJax rendering configuration
 * CVM-Role:        Configuration
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Defines the TeX packages the renderer always enables and
 *                  validates user-supplied MathJax macro definitions. The
 *                  macros themselves are not defined here: they are loaded from
 *                  the user's macro file (see load-mathjax-macros).
 *
 * END HEADER
 */

export type MathJaxMacro = string | readonly [string, number] | readonly [string, number, string];

/**
 * The TeX input packages the fork always enables. `base` is implicit; the HTML
 * export projection re-adds the remainder via Pandoc's `[+]` merge key.
 */
export const mathJaxPackages = [
  "base",
  "ams",
  "configmacros",
  "mhchem",
  "newcommand",
  "noundefined",
] as const;

/**
 * Type guard for a single MathJax macro definition (the `tex.macros` value
 * shape: replacement string, or [replacement, argCount, optionalDefault?]).
 */
export function isMathJaxMacro(value: unknown): value is MathJaxMacro {
  if (typeof value === "string") {
    return true;
  }
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "string" ||
    !Number.isInteger(value[1]) ||
    value[1] <= 0
  ) {
    return false;
  }
  if (value.length === 2) {
    return true;
  }
  return value.length === 3 && typeof value[2] === "string";
}

/**
 * Validates a parsed MathJax macro map (the standard `tex.macros` shape:
 * name → replacement string, or name → [replacement, argCount, optionalDefault?]).
 * Any malformed entry throws rather than being silently dropped, so a broken
 * macro file fails loudly instead of rendering without the affected macro.
 */
export function parseMathJaxMacros(data: unknown): Record<string, MathJaxMacro> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("MathJax macros must be a JSON object mapping macro names to definitions");
  }

  const macros: Record<string, MathJaxMacro> = {};
  for (const [name, definition] of Object.entries(data)) {
    if (!isMathJaxMacro(definition)) {
      throw new TypeError(`Invalid MathJax macro definition for "${name}"`);
    }
    macros[name] = definition;
  }
  return macros;
}
