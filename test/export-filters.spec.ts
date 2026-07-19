import assert from 'assert'
import { execFile } from 'child_process'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import YAML from 'yaml'
import { writeDefaults } from 'source/app/service-providers/commands/exporter/index'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'
import type { MathJaxMacro } from 'source/common/util/mathjax-config'

const execFileAsync = promisify(execFile)

let macros: Record<string, MathJaxMacro>
before(async function () {
  macros = await loadMathJaxMacros('test/fixtures/mathjax-macros.json')
})

const config = {
  export: { cslLibrary: '', cslStyle: '', stripTags: false, stripLinks: 'no' as const, enforceMarkSupport: false, injectMathHeaders: true },
  zkn: { linkFormat: 'link|title' as const }
}

describe('Declarative export filter chain', function () {
  it('prepends the declared filters before the profile filters and runs them', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-export-filters-'))
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.tex')
    const markFilter = path.join(directory, 'mark.lua')

    await writeFile(inputFile, '::: {.theorem}\nThis is a theorem.\n:::\n')
    await writeFile(markFilter, 'function Div(el)\n  if el.classes[1] == "theorem" then\n    return pandoc.RawBlock("latex", "THEOREM_MARKER")\n  end\nend\n')

    const latexProfile = YAML.parse(await readFile('static/defaults/LaTeX.yaml', { encoding: 'utf8' })) as Record<string, unknown>

    await writeDefaults(
      latexProfile,
      { 'input-files': [ inputFile ], 'output-file': outputFile, standalone: true },
      config,
      [ markFilter ], // the declared, ordered export filter chain
      directory,
      path.join(directory, 'unused.js'),
      macros
    )

    // The written defaults must list the declared filter BEFORE the profile's
    // citeproc, not appended after it.
    const written = YAML.parse(await readFile(path.join(directory, 'defaults.yml'), { encoding: 'utf8' })) as { filters: unknown[] }
    assert.strictEqual(written.filters[0], markFilter)
    assert.ok(written.filters.some(f => typeof f === 'object' && f !== null && (f as { type?: string }).type === 'citeproc'))
    assert.ok(written.filters.indexOf(markFilter) < written.filters.findIndex(f => typeof f === 'object' && (f as { type?: string })?.type === 'citeproc'))

    // And the declared filter actually runs against real Pandoc.
    await execFileAsync('pandoc', [ '--defaults', path.join(directory, 'defaults.yml') ])
    const tex = await readFile(outputFile, { encoding: 'utf8' })
    assert.match(tex, /THEOREM_MARKER/)
  })
})

describe('Export math-header injection toggle', function () {
  it('skips the local MathJax injection when injectMathHeaders is off', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-export-nomath-'))
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.html')

    await writeFile(inputFile, '$\\RR$\n')
    const htmlProfile = YAML.parse(await readFile('static/defaults/HTML.yaml', { encoding: 'utf8' })) as Record<string, unknown>
    const noInject = { export: { ...config.export, injectMathHeaders: false }, zkn: config.zkn }

    await writeDefaults(
      htmlProfile,
      { 'input-files': [ inputFile ], 'output-file': outputFile, standalone: true },
      noInject,
      [],
      directory,
      path.join(directory, 'unused.js'),
      macros
    )

    const written = YAML.parse(await readFile(path.join(directory, 'defaults.yml'), { encoding: 'utf8' })) as Record<string, unknown>
    const headers = (written['include-in-header'] ?? []) as string[]
    assert.ok(!headers.some(h => /zettlr-mathjax/.test(h)), 'no injected MathJax header')
    // Injection deletes the profile's html-math-method; skipping preserves it.
    assert.ok(written['html-math-method'] !== undefined, 'profile html-math-method survives')
  })
})
