/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MathJax rendering utility
 * CVM-Role:        Utility functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module renders MathTeX equations into CommonHTML strings
 *                  and elements with MathJax.
 *
 * END HEADER
 */

import { mathjax } from '@mathjax/src/cjs/mathjax.js'
import { TeX } from '@mathjax/src/cjs/input/tex.js'
import { CHTML } from '@mathjax/src/cjs/output/chtml.js'
import { liteAdaptor } from '@mathjax/src/cjs/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from '@mathjax/src/cjs/handlers/html.js'
import '@mathjax/src/cjs/util/asyncLoad/node.js'
import '@mathjax/src/cjs/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/cjs/input/tex/configmacros/ConfigMacrosConfiguration.js'
import '@mathjax/src/cjs/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/cjs/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/cjs/input/tex/noundefined/NoUndefinedConfiguration.js'
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/cjs/chtml.js'
import { mathJaxConfig } from './mathjax-config'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

const tex = new TeX({
  packages: mathJaxConfig.packages,
  macros: mathJaxConfig.macros
})
const chtml = new CHTML({ fontData: MathJaxNewcmFont })
const html = mathjax.document('', { InputJax: tex, OutputJax: chtml })

chtml.font.loadDynamicFilesSync()

function mathJaxToNode (equation: string, displayMode: boolean) {
  return html.convert(equation, { display: displayMode })
}

/**
 * Renders the provided equation to HTML and places it inside the provided
 * element.
 *
 * @param   {string}       equation     The MathTeX equation.
 * @param   {HTMLElement}  element      The target element.
 * @param   {boolean}      displayMode  Whether to use displayMode.
 */
export function katexToElem (equation: string, element: HTMLElement, displayMode: boolean) {
  element.innerHTML = adaptor.outerHTML(mathJaxToNode(equation, displayMode))
}

/**
 * Renders the provided equation to HTML and returns the HTML string.
 *
 * @param   {string}   equation     The MathTeX equation.
 * @param   {boolean}  displayMode  Whether to use displayMode.
 *
 * @return  {string}                The equation as HTML.
 */
export function katexToHTML (equation: string, displayMode: boolean): string {
  return adaptor.outerHTML(mathJaxToNode(equation, displayMode))
}
