/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MathTeX HTML Rendering Test
 * CVM-Role:        Test
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests MathJax CommonHTML rendering.
 *
 * END HEADER
 */

import { strict as assert } from "assert"
import { katexToElem, katexToHTML } from "source/common/util/mathtex-to-html"

describe('Utility#katexToHTML()', function () {
  it('renders configured macros and mhchem as CommonHTML display math', function () {
    const html = katexToHTML('\\RR + \\pair{a}{b} + \\optpair[x]{y} + \\ce{H2O}', true)

    assert.match(html, /<mjx-container class="MathJax" jax="CHTML"[^>]*display="true">/)
    assert.match(html, /mjx-c211D NCM-DS/)
    assert.match(html, /<mjx-msub /)
    assert.match(html, /data-latex="\\left\\langle a, b/)
    assert.match(html, /data-latex="\\left\\langle y, x/)
    assert.match(html, /data-latex="\\mathrm\{H\}"/)

    const stylesheet = document.getElementById('MJX-CHTML-styles')
    assert.ok(stylesheet)
    assert.match(stylesheet.textContent ?? '', /url\("mathjax\/mjx-ncm-ds\.woff2"\)/)
    assert.doesNotMatch(stylesheet.textContent ?? '', /https?:\/\//)
  })
  it('renders into the supplied element synchronously', function () {
    const element = document.createElement('div')

    katexToElem('\\RR', element, false)

    assert.match(element.innerHTML, /<mjx-container class="MathJax" jax="CHTML"/)
    assert.match(element.innerHTML, /mjx-c211D NCM-DS/)
  })
})