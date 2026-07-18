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
import { liteAdaptor } from '@mathjax/src/cjs/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from '@mathjax/src/cjs/handlers/html.js'
import '@mathjax/src/cjs/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/cjs/input/tex/configmacros/ConfigMacrosConfiguration.js'
import '@mathjax/src/cjs/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/cjs/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/cjs/input/tex/noundefined/NoUndefinedConfiguration.js'
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/cjs/chtml.js'
import { mathJaxConfig } from './mathjax-config'

import './mathjax-newcm-dynamic'

const documentElement = globalThis.document

const tex = new TeX({
  packages: mathJaxConfig.packages,
  macros: mathJaxConfig.macros
})

const browserRenderer = documentElement === undefined
  ? undefined
  : (() => {
    const adaptor = browserAdaptor()
    RegisterHTMLHandler(adaptor)
    const chtml = new CHTML({
      fontData: MathJaxNewcmFont,
      fontURL: new URL('../mathjax', documentElement.baseURI).href,
      dynamicPrefix: ''
    })
    return { adaptor, chtml, html: mathjax.document(documentElement, { InputJax: tex, OutputJax: chtml }) }
  })()

const mainRenderer = documentElement === undefined
  ? (() => {
    const adaptor = liteAdaptor()
    RegisterHTMLHandler(adaptor)
    const chtml = new CHTML({ fontData: MathJaxNewcmFont, dynamicPrefix: '' })
    return { adaptor, chtml, html: mathjax.document('', { InputJax: tex, OutputJax: chtml }) }
  })()
  : undefined

mathjax.asyncLoad = () => Promise.resolve()

let initialized = false
let initializing: Promise<void>|undefined

export function initializeMathJax (): Promise<void> {
  if (initialized) {
    return Promise.resolve()
  }

  if (initializing === undefined) {
    const renderer = browserRenderer ?? mainRenderer
    if (renderer === undefined) {
      throw new Error('MathJax renderer is unavailable')
    }
    initializing = renderer.chtml.font.loadDynamicFiles().then(() => {
      renderer.html.updateDocument()
      initialized = true
    })
  }

  return initializing
}

type MathJaxDisplay = 'inline'|'display'

function mathJaxToNode (equation: string, display: MathJaxDisplay) {
  if (!initialized) {
    throw new Error('MathJax must be initialized before rendering')
  }

  const renderer = browserRenderer ?? mainRenderer
  if (renderer === undefined) {
    throw new Error('MathJax renderer is unavailable')
  }

  const node = renderer.html.convert(equation, { display: display === 'display' })
  renderer.html.updateDocument()
  return node
}

/**
 * Renders the provided equation to HTML and places it inside the provided
 * element.
 *
 * @param   {string}       equation     The MathTeX equation.
 * @param   {HTMLElement}  element      The target element.
 * @param   {'inline'|'display'}  display   The MathJax display variant.
 */
export function mathJaxToElem (equation: string, element: HTMLElement, display: MathJaxDisplay) {
  element.replaceChildren(mathJaxToNode(equation, display))
}

/**
 * Renders the provided equation to HTML and returns the HTML string.
 *
 * @param   {'inline'|'display'}  display   The MathJax display variant.
 *
 * @return  {string}                     The equation as HTML.
 */
export function mathJaxToHTML (equation: string, display: MathJaxDisplay): string {
  const renderer = browserRenderer ?? mainRenderer
  if (renderer === undefined) {
    throw new Error('MathJax renderer is unavailable')
  }

  return renderer.adaptor.outerHTML(mathJaxToNode(equation, display))
}
