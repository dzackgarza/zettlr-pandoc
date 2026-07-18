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
import { browserAdaptor } from '@mathjax/src/cjs/adaptors/browserAdaptor.js'
import { RegisterHTMLHandler } from '@mathjax/src/cjs/handlers/html.js'
import '@mathjax/src/cjs/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/cjs/input/tex/configmacros/ConfigMacrosConfiguration.js'
import '@mathjax/src/cjs/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/cjs/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/cjs/input/tex/noundefined/NoUndefinedConfiguration.js'
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/cjs/chtml.js'
import { mathJaxConfig } from './mathjax-config'

import './mathjax-newcm-dynamic'

const adaptor = browserAdaptor()
RegisterHTMLHandler(adaptor)

const tex = new TeX({
  packages: mathJaxConfig.packages,
  macros: mathJaxConfig.macros
})
const chtml = new CHTML({
  fontData: MathJaxNewcmFont,
  fontURL: `${document.baseURI === 'about:blank' ? '/' : document.baseURI}mathjax`,
  dynamicPrefix: ''
})
const html = mathjax.document(document, { InputJax: tex, OutputJax: chtml })

mathjax.asyncLoad = () => Promise.resolve()

let initialized = false
let initializing: Promise<void> | undefined

export function initializeMathJax (): Promise<void> {
  if (initialized) return Promise.resolve()

  if (initializing === undefined) {
    initializing = chtml.font.loadDynamicFiles().then(() => {
      html.updateDocument()
      initialized = true
    })
  }

  return initializing
}

function mathJaxToNode (equation: string, displayMode: boolean) {
  if (!initialized) {
    throw new Error('MathJax must be initialized before rendering')
  }

  const node = html.convert(equation, { display: displayMode })
  html.updateDocument()
  return node
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
  element.replaceChildren(mathJaxToNode(equation, displayMode))
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
  return mathJaxToNode(equation, displayMode).outerHTML
}
