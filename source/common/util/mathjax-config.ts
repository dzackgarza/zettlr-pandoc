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
 *                  The macro set is a static, checked-in snapshot vendored from
 *                  ~/.pandoc (github.com/dzackgarza/pandoc-config), generated
 *                  there by bin/generate-mathjax-config.py. Refresh the snapshot
 *                  with `just sync-mathjax-macros`; do not hand-edit the
 *                  generated file.
 *
 * END HEADER
 */

import { macros } from './mathjax-macros.generated'

export type MathJaxMacro =
  | string
  | readonly [string, number]
  | readonly [string, number, string]

export const mathJaxConfig = {
  packages: [ 'base', 'ams', 'configmacros', 'mhchem', 'newcommand', 'noundefined' ],
  macros: macros satisfies Readonly<Record<string, MathJaxMacro>>
} as const
