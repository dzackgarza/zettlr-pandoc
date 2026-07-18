/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MathJax rendering configuration
 * CVM-Role:        Configuration
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Defines the TeX packages and macros used by the renderer.
 *
 * END HEADER
 */

export type MathJaxMacro =
  | string
  | readonly [string, number]
  | readonly [string, number, string]

export const mathJaxConfig = {
  packages: [ 'base', 'ams', 'configmacros', 'mhchem', 'newcommand', 'noundefined' ],
  macros: {
    RR: '\\mathbb{R}',
    pair: [ '\\left\\langle #1, #2 \\right\\rangle', 2 ],
    optpair: [ '\\left\\langle #2, #1 \\right\\rangle', 2, '' ]
  } satisfies Readonly<Record<string, MathJaxMacro>>
} as const
