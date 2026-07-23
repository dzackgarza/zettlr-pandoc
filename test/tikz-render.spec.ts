/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ render service red proofs (issue #14)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the main-process TikZ render contract: the vendored
 *                  tikzcd.lua filter runs through real pandoc against the
 *                  app-owned asset tree (never ~/.pandoc), producing inline
 *                  SVG with namespaced ids and a lightbox-servable SVG file;
 *                  a failing figure surfaces the filter's mapped bang-error
 *                  diagnostic; a machine without pdflatex/pdf2svg gets a
 *                  typed missing-tools result, never silence.
 *
 *                  The compile proofs run the real toolchain when pdflatex
 *                  and pdf2svg exist; on a machine without them the same
 *                  cases must yield the typed missing-tools result — either
 *                  way every assertion is against the declared contract, no
 *                  silent skips.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { renderTikz, type TikzRenderResult } from 'source/app/util/tikz-render'

const TIKZ_ASSET_DIR = path.join(process.cwd(), 'static/tikz')

const TIKZCD_OK = '\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}'
const TIKZCD_BROKEN = '\\begin{tikzcd}\nA \\arrow[r] & B \\thisMacroDoesNotExist\n\\end{tikzcd}'

function toolPresent (tool: string): boolean {
  return spawnSync('which', [ tool ]).status === 0
}

const toolchainPresent = toolPresent('pdflatex') && toolPresent('pdf2svg')

describe('TikZ render service (issue #14)', function () {
  let cacheDir: string

  before(async function () {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-render-'))
  })

  after(async function () {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('reports missing pdflatex/pdf2svg as a typed result, never silence', async function () {
    this.timeout(60000)
    const emptyBin = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-nobin-'))
    try {
      const result = await renderTikz(
        { source: TIKZCD_OK, kind: 'raw' },
        { tikzAssetDir: TIKZ_ASSET_DIR, cacheDir, env: { ...process.env, PATH: emptyBin } }
      )
      assert.strictEqual(result.ok, false)
      assert.ok(result.ok === false && result.kind === 'missing-tools', `expected missing-tools, got ${JSON.stringify(result).slice(0, 200)}`)
      if (result.ok === false && result.kind === 'missing-tools') {
        assert.ok(result.missing.includes('pdflatex'), 'pdflatex must be named missing')
        assert.ok(result.missing.includes('pdf2svg'), 'pdf2svg must be named missing')
      }
    } finally {
      await rm(emptyBin, { recursive: true, force: true })
    }
  })

  it('renders a tikzcd snippet to namespaced inline SVG plus a lightbox file, or reports the toolchain', async function () {
    this.timeout(120000)
    const result: TikzRenderResult = await renderTikz(
      { source: TIKZCD_OK, kind: 'raw' },
      { tikzAssetDir: TIKZ_ASSET_DIR, cacheDir }
    )

    if (!toolchainPresent) {
      assert.ok(result.ok === false && result.kind === 'missing-tools', 'without the toolchain the typed missing-tools result is required')
      return
    }

    assert.ok(result.ok, `expected a successful render, got ${JSON.stringify(result).slice(0, 400)}`)
    if (result.ok) {
      assert.ok(result.html.includes('<svg'), 'the result embeds inline SVG')
      // The filter namespaces every id/use pair with a content-hash prefix so
      // several figures can share one document.
      const idMatch = result.html.match(/id="([0-9a-f]{8})-/)
      assert.ok(idMatch !== null, 'SVG element ids carry the content-hash namespace prefix')
      assert.ok(result.html.includes(`xlink:href="#${idMatch?.[1] ?? ''}-`), 'use references are namespaced with the same prefix')
      assert.ok(existsSync(result.svgPath), 'a lightbox-servable SVG file exists')
      assert.ok(readFileSync(result.svgPath, 'utf8').includes('<svg'), 'the lightbox file is an SVG document')
      assert.ok(result.svgPath.startsWith(cacheDir), 'the SVG file lives in the app-owned cache dir')
    }
  })

  it('serves a repeat render from the content-addressed cache', async function () {
    this.timeout(120000)
    const first = await renderTikz({ source: TIKZCD_OK, kind: 'raw' }, { tikzAssetDir: TIKZ_ASSET_DIR, cacheDir })
    if (!toolchainPresent) {
      assert.ok(first.ok === false && first.kind === 'missing-tools')
      return
    }
    const started = Date.now()
    const second = await renderTikz({ source: TIKZCD_OK, kind: 'raw' }, { tikzAssetDir: TIKZ_ASSET_DIR, cacheDir })
    const elapsed = Date.now() - started
    assert.ok(second.ok, 'the repeat render succeeds')
    assert.ok(elapsed < 5000, `a cache hit must not re-run pdflatex (took ${elapsed}ms)`)
  })

  it('maps a figure-compile failure back to the tikz source line', async function () {
    this.timeout(120000)
    const result = await renderTikz(
      { source: TIKZCD_BROKEN, kind: 'raw' },
      { tikzAssetDir: TIKZ_ASSET_DIR, cacheDir }
    )
    if (!toolchainPresent) {
      assert.ok(result.ok === false && result.kind === 'missing-tools')
      return
    }
    assert.ok(result.ok === false, 'a broken figure must not report success')
    if (result.ok === false) {
      assert.strictEqual(result.kind, 'compile-error', `expected compile-error, got ${JSON.stringify(result).slice(0, 400)}`)
      if (result.kind === 'compile-error') {
        assert.ok(result.errors.length > 0, 'the bang-error diagnostic is surfaced')
        const error = result.errors[0]
        assert.ok(error.message.toLowerCase().includes('undefined control sequence'), `the LaTeX message is carried: ${error.message}`)
        assert.ok(error.sourceLine.includes('\\thisMacroDoesNotExist'), `the verbatim source line is carried: ${error.sourceLine}`)
        assert.strictEqual(error.line, 2, 'the line is mapped into the figure body, not the generated .tex')
      }
    }
  })

  it('never reads from ~/.pandoc: the vendored tree is the only asset source', function () {
    const filter = readFileSync(path.join(TIKZ_ASSET_DIR, 'filters/tikzcd.lua'), 'utf8')
    assert.ok(!filter.includes("home .. '/.pandoc"), 'the vendored filter must not resolve modules from ~/.pandoc')
  })
})
