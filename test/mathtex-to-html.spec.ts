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
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { initializeMathJax, mathJaxToElem, mathJaxToHTML } from "source/common/util/mathtex-to-html"

it('requires initialization before conversion', function () {
  assert.throws(() => mathJaxToHTML('\\RR', 'inline'), Error)
})

it('registers updater IPC only after its boot initialization', function () {
  const source = readFileSync(resolve('source/app/service-providers/updates/index.ts'), 'utf8')
  const boot = source.slice(source.indexOf('async boot (): Promise<void>'))

  assert.ok(boot.indexOf('await initializeMathJax()') < boot.indexOf('this._registerIpcHandler()'))
})

it('renders updater Markdown with the lite adaptor without a global document', function () {
  const html = execFileSync(process.execPath, [
    '--import', 'tsx',
    '--input-type', 'module',
    '--eval',
    `import { initializeMathJax } from './source/common/util/mathtex-to-html.ts'
import { md2html } from './source/common/modules/markdown-utils/markdown-to-html.ts'
await initializeMathJax()
process.stdout.write(await md2html('$$\\\\RR$$', { onCitation: () => undefined, zknLinkFormat: 'link|title' }))`
  ], { encoding: 'utf8' })

  assert.match(html, /<mjx-container[^>]*display="true"/)
  assert.match(html, /ℝ/)
})

describe('Utility#mathJaxToHTML()', function () {
  before(async function () {
    // Full-stylesheet initialization loads every dynamic font module once.
    this.timeout(30000)
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