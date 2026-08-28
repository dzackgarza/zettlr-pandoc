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

import { isMathJaxMacro, type MathJaxMacro } from "@common/util/mathjax-config";

function assertMacroDefinition(
  name: string,
  definition: unknown,
): asserts definition is MathJaxMacro {
  if (!isMathJaxMacro(definition)) {
    throw new TypeError(`Unsupported macro definition for ${name}`);
  }
}

function sortedEntries(macros: Record<string, unknown>): Array<[string, MathJaxMacro]> {
  return Object.entries(macros)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, definition]) => {
      assertMacroDefinition(name, definition);
      return [name, definition];
    });
}

/**
 * Produces a deterministic MathJax configuration script for Pandoc HTML headers.
 */
export function projectMathJaxHeader(macros: Record<string, unknown>): string {
  const config = Object.fromEntries(sortedEntries(macros));
  const json = JSON.stringify({ tex: { macros: config } }, null, 2).replace(
    /<\/script/gi,
    "<\\/script",
  );

  return `<script>\nwindow.MathJax = ${json};\n</script>`;
}

/**
 * Produces deterministic TeX macro definitions for Pandoc TeX headers.
 *
 * Emitted with \providecommand, not \newcommand: a LaTeX template's own preamble
 * (e.g. dzg-unified -> dzg-macros) commonly defines the same blackboard macros
 * (\RR, \CC, ...), and \newcommand aborts the build with "Command already
 * defined" on the redefinition. \providecommand is a no-op when the macro
 * already exists (the template's definition wins) yet still defines it when no
 * template provides one, so injection never collides.
 */
export function projectTexHeader(macros: Record<string, unknown>): string {
  return sortedEntries(macros)
    .map(([name, definition]) => {
      if (typeof definition === "string") {
        return `\\providecommand{\\${name}}{${definition}}`;
      }

      const [body, requiredArguments, optionalDefault] = definition;
      const optionalArguments = optionalDefault === undefined ? "" : `[${optionalDefault}]`;
      return `\\providecommand{\\${name}}[${requiredArguments}]${optionalArguments}{${body}}`;
    })
    .join("\n");
}
