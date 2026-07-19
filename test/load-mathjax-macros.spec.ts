import { strict as assert } from 'assert'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ensureMacroExample, loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'

const VALID = 'test/fixtures/mathjax-macros.json'
const MALFORMED = 'test/fixtures/mathjax-macros.malformed.json'
const SHIPPED_EXAMPLE = 'static/mathjax-macros.example.json'

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

  it('ships a valid example the loader accepts', async function () {
    const macros = await loadMathJaxMacros(SHIPPED_EXAMPLE)
    assert.ok(Object.keys(macros).length > 0)
  })
})

describe('ensureMacroExample()', function () {
  it('writes the example file when the config directory has none', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-macro-example-'))
    await ensureMacroExample(directory, SHIPPED_EXAMPLE)

    const written = await readFile(path.join(directory, 'mathjax-macros.json.example'), { encoding: 'utf8' })
    assert.strictEqual(written, await readFile(SHIPPED_EXAMPLE, { encoding: 'utf8' }))
  })

  it('does not overwrite an existing example file', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-macro-example-'))
    const target = path.join(directory, 'mathjax-macros.json.example')
    await writeFile(target, 'user edited')
    await ensureMacroExample(directory, SHIPPED_EXAMPLE)

    assert.strictEqual(await readFile(target, { encoding: 'utf8' }), 'user edited')
  })
})
