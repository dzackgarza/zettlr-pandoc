import { strict as assert } from 'assert'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'

const VALID = 'test/fixtures/mathjax-macros.json'
const MALFORMED = 'test/fixtures/mathjax-macros.malformed.json'

describe('loadMathJaxMacros()', function () {
  it('parses a MathJax macro file into validated definitions', async function () {
    const macros = await loadMathJaxMacros(VALID)

    assert.strictEqual(macros.RR, '\\mathbb{R}')
    assert.deepStrictEqual(macros.qty, [ '\\left( {#1} \\right)', 1 ])
    assert.deepStrictEqual(macros.optpair, [ '\\left\\langle {#2}, {#1} \\right\\rangle', 2, '' ])
  })

  it('treats an absent macro file as no custom macros', async function () {
    assert.deepStrictEqual(await loadMathJaxMacros('test/fixtures/does-not-exist.json'), {})
  })

  it('fails loudly on a malformed macro definition instead of dropping it', async function () {
    await assert.rejects(loadMathJaxMacros(MALFORMED), /broken/)
  })
})
