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
import { initializeMathJax, mathJaxToElem, mathJaxToHTML } from "source/common/util/mathtex-to-html"

it('requires initialization before conversion', function () {
  assert.throws(() => mathJaxToHTML('\\RR', 'inline'), Error)
})

describe('Utility#mathJaxToHTML()', function () {
  before(async function () {
    await initializeMathJax()
  })

  it('serializes configured macros and mhchem as CommonHTML display math', function () {
    const html = mathJaxToHTML('\\RR + \\pair{a}{b} + \\optpair[x]{y} + \\ce{H2O}', 'display')

    const rendered = document.createElement('div')
    rendered.innerHTML = html

    assert.equal(rendered.querySelector('mjx-container')?.getAttribute('display'), 'true')
    assert.match(rendered.textContent ?? '', /ℝ/)
    assert.match(rendered.textContent ?? '', /⟨𝑎,𝑏⟩/)
    assert.match(rendered.textContent ?? '', /⟨𝑦,𝑥⟩/)
    assert.equal(rendered.querySelector('mjx-msub')?.textContent, '𝐴2')

    const stylesheet = document.getElementById('MJX-CHTML-styles')
    assert.ok(stylesheet)
    assert.match(stylesheet.textContent ?? '', /url\("http:\/\/localhost:3000\/mathjax\/mjx-ncm-ds\.woff2"\)/)
    assert.doesNotMatch(stylesheet.textContent ?? '', /cdn\.jsdelivr\.net|@mathjax\//)
  })

  it('inserts CommonHTML into the supplied element synchronously', function () {
    const element = document.createElement('div')

    mathJaxToElem('\\RR', element, 'inline')

    assert.equal(element.querySelector('mjx-container')?.getAttribute('jax'), 'CHTML')
    assert.match(element.textContent ?? '', /ℝ/)
  })
})