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
import '@mathjax/src/cjs/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/cjs/input/tex/configmacros/ConfigMacrosConfiguration.js'
import '@mathjax/src/cjs/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/cjs/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/cjs/input/tex/noundefined/NoUndefinedConfiguration.js'
import { type LiteDocument } from '@mathjax/src/cjs/adaptors/lite/Document.js'
import { LiteElement, type LiteNode } from '@mathjax/src/cjs/adaptors/lite/Element.js'
import { type LiteText } from '@mathjax/src/cjs/adaptors/lite/Text.js'
import { type MathDocument } from '@mathjax/src/cjs/core/MathDocument.js'
import { type MmlNode } from '@mathjax/src/cjs/core/MmlTree/MmlNode.js'
import { HTMLDocument } from '@mathjax/src/cjs/handlers/html/HTMLDocument.js'
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/cjs/chtml.js'
import { MathJaxMhchemFontExtension } from '@mathjax/mathjax-mhchem-font-extension/cjs/chtml.js'
import { mathJaxPackages, type MathJaxMacro } from './mathjax-config'

import './mathjax-newcm-dynamic'

const documentElement = globalThis.document

// Register the mhchem glyphs (long reaction arrows and bonds) on the font
// class before any output jax is constructed: with the complete stylesheet
// (adaptiveCSS: false) only class-level registration emits the @font-face
// rules for the extension's own woff2 files.
MathJaxNewcmFont.addExtension({
  ...MathJaxMhchemFontExtension,
  fontURL: documentElement === undefined
    ? ''
    : new URL('../mathjax', documentElement.baseURI).href
})

type BrowserDocument = MathDocument<HTMLElement, Text, Document>
type MainDocument = MathDocument<LiteNode, LiteText, LiteDocument>

let browserRenderer: BrowserDocument|undefined
let mainRenderer: MainDocument|undefined
let browserChtml: CHTML<HTMLElement, Text, Document>|undefined
let mainChtml: CHTML<LiteElement, LiteText, LiteDocument>|undefined
let browserAdaptorInstance: ReturnType<typeof browserAdaptor>|undefined
let mainAdaptorInstance: ReturnType<typeof liteAdaptor>|undefined

mathjax.asyncLoad = () => Promise.resolve()

let initialized = false
let initializing: Promise<void>|undefined

/**
 * Constructs the MathJax input/output pipeline with the supplied macro set and
 * loads the font data. The macros come from the user's macro file (renderer:
 * fetched over IPC; main process: read from disk), so no macro set is baked
 * into the app. This is restart-gated: the first call builds the renderer and
 * subsequent calls return the same in-flight/settled promise, ignoring any
 * later macro argument.
 *
 * @param   {Record<string, MathJaxMacro>}  macros  The user's macro definitions.
 */
export function initializeMathJax (macros: Record<string, MathJaxMacro>): Promise<void> {
  if (initializing !== undefined) {
    return initializing
  }

  const tex = new TeX({ packages: [ ...mathJaxPackages ], macros })

  if (documentElement === undefined) {
    mainAdaptorInstance = liteAdaptor()
    mainChtml = new CHTML<LiteElement, LiteText, LiteDocument>({
      fontData: MathJaxNewcmFont,
      dynamicPrefix: '',
      // Emit the complete stylesheet: widgets render incrementally, so
      // adaptive CSS would miss constructs first used after initialization.
      adaptiveCSS: false
    })
    mainRenderer = new HTMLDocument(mainAdaptorInstance.parse(''), mainAdaptorInstance, { InputJax: tex, OutputJax: mainChtml })
    initializing = mainChtml.font.loadDynamicFiles().then(() => {
      initialized = true
    })
  } else {
    browserAdaptorInstance = browserAdaptor()
    browserChtml = new CHTML({
      fontData: MathJaxNewcmFont,
      fontURL: new URL('../mathjax', documentElement.baseURI).href,
      dynamicPrefix: '',
      // Emit the complete stylesheet: widgets render incrementally, so
      // adaptive CSS would miss constructs first used after initialization.
      adaptiveCSS: false
    })
    browserRenderer = new HTMLDocument(documentElement, browserAdaptorInstance, { InputJax: tex, OutputJax: browserChtml })
    initializing = browserChtml.font.loadDynamicFiles().then(() => {
      browserRenderer?.updateDocument()
      initialized = true
    })
  }

  return initializing
}

type MathJaxDisplay = 'inline'|'display'

function isMmlNode (node: LiteNode|HTMLElement|MmlNode): node is MmlNode {
  return 'isToken' in node
}

function mathJaxToBrowserNode (equation: string, display: MathJaxDisplay): HTMLElement {
  if (browserRenderer === undefined) {
    throw new Error('Browser MathJax renderer is unavailable')
  }

  const node = browserRenderer.convert(equation, { display: display === 'display' })
  if (isMmlNode(node)) {
    throw new Error('MathJax did not produce HTML')
  }
  browserRenderer.updateDocument()
  return node
}

function mathJaxToMainNode (equation: string, display: MathJaxDisplay): LiteElement {
  if (mainRenderer === undefined) {
    throw new Error('Main-process MathJax renderer is unavailable')
  }

  const node = mainRenderer.convert(equation, { display: display === 'display' })
  if (isMmlNode(node) || !(node instanceof LiteElement)) {
    throw new Error('MathJax did not produce HTML')
  }
  mainRenderer.updateDocument()
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
  if (!initialized) {
    throw new Error('MathJax must be initialized before rendering')
  }

  element.replaceChildren(mathJaxToBrowserNode(equation, display))
}

/**
 * Renders the provided equation to HTML and returns the HTML string.
 *
 * @param   {'inline'|'display'}  display   The MathJax display variant.
 *
 * @return  {string}                     The equation as HTML.
 */
export function mathJaxToHTML (equation: string, display: MathJaxDisplay): string {
  if (!initialized) {
    throw new Error('MathJax must be initialized before rendering')
  }

  if (browserRenderer === undefined) {
    if (mainAdaptorInstance === undefined) {
      throw new Error('Main-process MathJax adaptor is unavailable')
    }
    return mainAdaptorInstance.outerHTML(mathJaxToMainNode(equation, display))
  }

  if (browserAdaptorInstance === undefined) {
    throw new Error('Browser MathJax adaptor is unavailable')
  }
  return browserAdaptorInstance.outerHTML(mathJaxToBrowserNode(equation, display))
}
