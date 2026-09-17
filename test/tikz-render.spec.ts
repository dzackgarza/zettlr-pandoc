/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ render service red proofs (issue #14)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the main-process TikZ render contract: tikzcd.lua
 *                  runs through real pandoc against an explicitly supplied
 *                  data tree and standalone template, producing inline
 *                  SVG with namespaced ids and a lightbox-servable SVG file;
 *                  a failing figure surfaces the filter's mapped bang-error
 *                  diagnostic; a machine without pdflatex/pdf2svg gets a
 *                  typed missing-tools result, never silence; a toolchain
 *                  probe that fails for a reason other than absence reports
 *                  the tool and the errno rather than posing as absence; a
 *                  render whose
 *                  pandoc process is killed reports the signal that killed it
 *                  rather than posing as a pandoc diagnostic; and the
 *                  request's docPath is the single representation of the
 *                  authoring document's location, empty when the buffer has
 *                  none.
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
import { randomBytes } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  latexBaseFontSizePt,
  renderTikz,
  resolveTikzDataDir,
  resolveTikzTemplatePath,
  tikzTemplateDependencyHash,
  tikzTemplateCompletions,
  tikzTemplateCommands,
  type TikzRenderResult
} from 'source/app/util/tikz-render'

const TIKZ_ASSET_DIR = path.join(process.cwd(), 'static/tikz')
const TIKZ_TEMPLATE = path.join(TIKZ_ASSET_DIR, 'templates/standalone-tikz.tex')

/**
 * The document location of a buffer that has never been written to disk. The
 * request models that fact with the empty path — the same value the editor
 * configuration holds in metadata.path — and the filter reads it as "no
 * document root", resolving \input against the working directory instead.
 */
const NO_DOC_PATH = ''

const TIKZCD_OK = '\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}'
const TIKZCD_BROKEN = '\\begin{tikzcd}\nA \\arrow[r] & B \\thisMacroDoesNotExist\n\\end{tikzcd}'

describe('TikZ TeX typography metadata', function () {
  it('reads the documentclass point size and defaults ordinary standalone documents to 10pt', function () {
    assert.strictEqual(latexBaseFontSizePt('\\documentclass{standalone}\n'), 10)
    assert.strictEqual(latexBaseFontSizePt('\\documentclass[tikz,border=2pt,11pt]{standalone}\n'), 11)
    assert.strictEqual(latexBaseFontSizePt('\\documentclass[12pt]{article}\n'), 12)
  })

  it('indexes macros from the owned template and its local package/input graph', async function () {
    const root = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-macros-'))
    try {
      const templates = path.join(root, 'templates')
      const styles = path.join(root, 'styles')
      await mkdir(path.join(styles, 'macros'), { recursive: true })
      await mkdir(templates, { recursive: true })
      const template = path.join(templates, 'standalone-tikz.tex')
      await writeFile(template, '\\documentclass{standalone}\n\\usepackage{owned}\n\\begin{document}\n<>\n\\end{document}\n')
      await writeFile(
        path.join(styles, 'owned.sty'),
        '\\newcommand{\\TemplateOnly}[1]{#1}\n\\input{macros/more}\n\\usepackage{graphicx}\n'
      )
      const nestedMacros = path.join(styles, 'macros', 'more.tex')
      await writeFile(
        nestedMacros,
        '\\providecommand\\NestedMacro{nested}\n\\def\\DefinedMacro#1{#1}\n'
      )

      const commands = tikzTemplateCommands(template)
      assert.ok(commands.includes('\\TemplateOnly'))
      assert.ok(commands.includes('\\NestedMacro'))
      assert.ok(commands.includes('\\DefinedMacro'))
      assert.ok(!commands.includes('\\includegraphics'), 'system-package commands belong to the standard LaTeX catalogue, not local template scanning')

      const completions = tikzTemplateCompletions(template)
      assert.deepEqual(
        completions.find(entry => entry.label === '\\TemplateOnly'),
        {
          label: '\\TemplateOnly',
          argumentCount: 1,
          declaration: '\\newcommand{\\TemplateOnly}[1]{#1}',
          sourceFile: path.join(styles, 'owned.sty')
        }
      )
      assert.equal(completions.find(entry => entry.label === '\\DefinedMacro')?.argumentCount, 1)

      const before = tikzTemplateDependencyHash(template)
      await writeFile(
        nestedMacros,
        '\\providecommand\\NestedMacro{changed-definition}\n\\def\\DefinedMacro#1{#1}\n'
      )
      const after = tikzTemplateDependencyHash(template)
      assert.notStrictEqual(after, before, 'editing a transitive macro file changes the render-context fingerprint')
      assert.strictEqual(
        tikzTemplateDependencyHash(template),
        after,
        'the dependency fingerprint is deterministic for an unchanged graph'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function toolPresent (tool: string): boolean {
  return spawnSync('which', [ tool ]).status === 0
}

const toolchainPresent = toolPresent('pdflatex') && toolPresent('pdf2svg')

/**
 * A figure body no previous run can have compiled, so the filter's
 * content-addressed cache cannot short-circuit the render being observed.
 */
function uncachedTikzcd (body: string): string {
  return `\\begin{tikzcd}\n% ${randomBytes(8).toString('hex')}\n${body}\n\\end{tikzcd}`
}

/** The pids of pandoc processes currently running the vendored filter. */
function filterProcessPids (): number[] {
  const found = spawnSync('pgrep', [ '-f', 'lua-filter.*tikzcd\\.lua' ], { encoding: 'utf8' })
  return found.stdout
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0)
}

/** The filter's per-figure scratch directories, named /tmp/<prefix>-<hash>. */
function filterScratchDirs (): string[] {
  return readdirSync(tmpdir()).filter(entry => /^tikz(cd|full)-[0-9a-f]+$/.test(entry))
}

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
        { source: TIKZCD_OK, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: { ...process.env, PATH: emptyBin } }
      )
      assert.strictEqual(result.ok, false)
      assert.ok(!result.ok && result.kind === 'missing-tools', `expected missing-tools, got ${JSON.stringify(result).slice(0, 200)}`)
      if (!result.ok && result.kind === 'missing-tools') {
        assert.ok(result.missing.includes('pdflatex'), 'pdflatex must be named missing')
        assert.ok(result.missing.includes('pdf2svg'), 'pdf2svg must be named missing')
      }
    } finally {
      await rm(emptyBin, { recursive: true, force: true })
    }
  })

  it('distinguishes a toolchain probe that failed from a tool that is absent', async function () {
    this.timeout(60000)
    // A pandoc that is present on the requested PATH and cannot be executed.
    // execvp fails with EACCES, which says nothing about whether pandoc is
    // installed — telling this user to install it sends them after a problem
    // they do not have, and the permission bit they do have stays invisible.
    const binDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-noexec-'))
    try {
      await writeFile(path.join(binDir, 'pandoc'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      const result = await renderTikz(
        { source: TIKZCD_OK, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: { ...process.env, PATH: binDir } }
      )
      assert.ok(!result.ok, 'a render whose toolchain could not be checked did not produce a figure')
      assert.strictEqual(
        result.kind,
        'toolchain-probe-failed',
        `a probe that failed is its own outcome, not absence, got ${JSON.stringify(result).slice(0, 200)}`
      )
      if (result.kind === 'toolchain-probe-failed') {
        assert.strictEqual(result.tool, 'pandoc', 'the tool whose probe failed is named')
        assert.strictEqual(result.code, 'EACCES', 'the errno that distinguishes this failure from absence is carried')
      }
    } finally {
      await rm(binDir, { recursive: true, force: true })
    }
  })

  it('renders a tikzcd snippet to namespaced inline SVG plus a lightbox file, or reports the toolchain', async function () {
    this.timeout(120000)
    const result: TikzRenderResult = await renderTikz(
      { source: TIKZCD_OK, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )

    if (!toolchainPresent) {
      assert.ok(!result.ok && result.kind === 'missing-tools', 'without the toolchain the typed missing-tools result is required')
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

  it('renders a fenced tikzcd body through the owned template rather than treating it as a standalone TeX document', async function () {
    this.timeout(120000)
    const body = `A \\arrow[r, "f-${randomBytes(4).toString('hex')}"] & B`
    const result = await renderTikz(
      { source: body, kind: 'fence', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )

    if (!toolchainPresent) {
      assert.ok(!result.ok && result.kind === 'missing-tools')
      return
    }

    assert.ok(result.ok, `fenced tikzcd must compile as a template-owned snippet: ${JSON.stringify(result).slice(0, 400)}`)
    if (result.ok) {
      assert.match(result.svg, /<svg/)
      assert.strictEqual(result.texFontSizePt, latexBaseFontSizePt(readFileSync(TIKZ_TEMPLATE, 'utf8')))
    }
  })

  it('serves a repeat render from the content-addressed cache', async function () {
    this.timeout(120000)
    const first = await renderTikz({ source: TIKZCD_OK, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH }, { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env })
    if (!toolchainPresent) {
      assert.ok(!first.ok && first.kind === 'missing-tools')
      return
    }
    const started = Date.now()
    const second = await renderTikz({ source: TIKZCD_OK, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH }, { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env })
    const elapsed = Date.now() - started
    assert.ok(second.ok, 'the repeat render succeeds')
    assert.ok(elapsed < 5000, `a cache hit must not re-run pdflatex (took ${elapsed}ms)`)
  })

  it('invalidates identical figure source when a transitive template macro definition changes', async function () {
    this.timeout(180000)
    const root = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-context-'))
    try {
      const templates = path.join(root, 'templates')
      const styles = path.join(root, 'styles')
      await mkdir(templates, { recursive: true })
      await mkdir(styles, { recursive: true })
      const template = path.join(templates, 'standalone-tikz.tex')
      const packagePath = path.join(styles, 'owned.sty')
      await writeFile(
        template,
        '\\documentclass[tikz,border=2pt]{standalone}\n\\usepackage{owned}\n\\begin{document}\n<>\n\\end{document}\n'
      )
      await writeFile(packagePath, '\\ProvidesPackage{owned}\n\\newcommand{\\CacheMacro}{A}\n')

      const source = `\\begin{tikzpicture}\n% ${randomBytes(8).toString('hex')}\n\\node {\\CacheMacro};\n\\end{tikzpicture}`
      const request = { source, kind: 'raw' as const, language: 'tikz' as const, docPath: NO_DOC_PATH }
      const beforeFiles = new Set(readdirSync(cacheDir).filter(name => /^dzgtikz-.*\.svg$/.test(name)))
      const first = await renderTikz(
        request,
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: template, cacheDir, env: process.env }
      )
      if (!toolchainPresent) {
        assert.ok(!first.ok && first.kind === 'missing-tools')
        return
      }
      assert.ok(first.ok, `initial macro-backed render must succeed: ${JSON.stringify(first).slice(0, 400)}`)
      const firstContext = tikzTemplateDependencyHash(template)

      await writeFile(packagePath, '\\ProvidesPackage{owned}\n\\newcommand{\\CacheMacro}{BBBB}\n')
      const secondContext = tikzTemplateDependencyHash(template)
      assert.notStrictEqual(secondContext, firstContext, 'the package edit changes the app-side render context')

      const second = await renderTikz(
        request,
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: template, cacheDir, env: process.env }
      )
      assert.ok(second.ok, `same source must recompile under the changed macro graph: ${JSON.stringify(second).slice(0, 400)}`)
      if (first.ok && second.ok) {
        assert.notStrictEqual(second.svg, first.svg, 'the changed macro definition reaches pdflatex output')
        assert.notStrictEqual(second.svgPath, first.svgPath, 'Viewer.js receives a changed artifact path for changed output')
      }

      const generated = readdirSync(cacheDir)
        .filter(name => /^dzgtikz-.*\.svg$/.test(name) && !beforeFiles.has(name))
      assert.strictEqual(
        generated.length,
        2,
        'the unchanged figure source occupies a new persistent cache entry after the macro dependency changes'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('force-render bypasses the filter cache and rewrites the generated SVG', async function () {
    this.timeout(180000)
    const source = uncachedTikzcd('A \\arrow[r, "force"] & B')
    const before = new Set(readdirSync(cacheDir).filter(name => /^dzgtikz-.*\.svg$/.test(name)))
    const first = await renderTikz(
      { source, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    if (!toolchainPresent) {
      assert.ok(!first.ok && first.kind === 'missing-tools')
      return
    }
    assert.ok(first.ok, `initial render must succeed, got ${JSON.stringify(first).slice(0, 400)}`)

    const generated = readdirSync(cacheDir)
      .filter(name => /^dzgtikz-.*\.svg$/.test(name) && !before.has(name))
    assert.strictEqual(generated.length, 1, 'this uncached source produces exactly one new filter-cache SVG')
    const cachedSvg = path.join(cacheDir, generated[0])
    const initialMtime = statSync(cachedSvg).mtimeMs

    await new Promise(resolve => setTimeout(resolve, 25))
    const cached = await renderTikz(
      { source, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    assert.ok(cached.ok, 'ordinary repeat render succeeds from cache')
    assert.strictEqual(statSync(cachedSvg).mtimeMs, initialMtime, 'ordinary repeat render leaves the filter cache file untouched')

    await new Promise(resolve => setTimeout(resolve, 25))
    const forced = await renderTikz(
      { source, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH, cachePolicy: 'refresh' },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    assert.ok(forced.ok, 'forced rerender succeeds')
    assert.ok(
      statSync(cachedSvg).mtimeMs > initialMtime,
      'forced rerender rewrites the filter-cache SVG instead of serving the previous artifact'
    )
  })

  it('keeps the last-good cached SVG when a forced refresh fails during conversion', async function () {
    this.timeout(180000)
    const source = uncachedTikzcd('A \\arrow[r, "preserve"] & B')
    const before = new Set(readdirSync(cacheDir).filter(name => /^dzgtikz-.*\.svg$/.test(name)))
    const first = await renderTikz(
      { source, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    if (!toolchainPresent) {
      assert.ok(!first.ok && first.kind === 'missing-tools')
      return
    }
    assert.ok(first.ok, `initial render must succeed, got ${JSON.stringify(first).slice(0, 400)}`)

    const generated = readdirSync(cacheDir)
      .filter(name => /^dzgtikz-.*\.svg$/.test(name) && !before.has(name))
    assert.strictEqual(generated.length, 1, 'this uncached source produces exactly one new filter-cache SVG')
    const cachedSvg = path.join(cacheDir, generated[0])
    const goodBytes = readFileSync(cachedSvg)

    // The render service probes every tool with --version before invoking
    // pandoc. This shim therefore looks available to the probe but fails when
    // the filter asks it to convert a PDF, reproducing the precise post-TeX
    // failure that used to overwrite/truncate svg_path in place.
    const failingBin = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-bad-pdf2svg-'))
    try {
      const shim = path.join(failingBin, 'pdf2svg')
      await writeFile(shim, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 1\n', { mode: 0o755 })
      const failed = await renderTikz(
        { source, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH, cachePolicy: 'refresh' },
        {
          tikzAssetDir: TIKZ_ASSET_DIR,
          templatePath: TIKZ_TEMPLATE,
          cacheDir,
          env: { ...process.env, PATH: `${failingBin}:${process.env.PATH ?? ''}` }
        }
      )
      assert.ok(!failed.ok, 'a forced refresh whose converter fails cannot report success')
      assert.deepStrictEqual(
        readFileSync(cachedSvg),
        goodBytes,
        'the converter failure leaves the previous cache/lightbox SVG byte-identical'
      )
    } finally {
      await rm(failingBin, { recursive: true, force: true })
    }
  })

  it('maps a figure-compile failure back to the tikz source line', async function () {
    this.timeout(120000)
    const result = await renderTikz(
      { source: TIKZCD_BROKEN, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    if (!toolchainPresent) {
      assert.ok(!result.ok && result.kind === 'missing-tools')
      return
    }
    assert.ok(!result.ok, 'a broken figure must not report success')
    if (!result.ok) {
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

  it('resolves the figure \\input against the document the request names', async function () {
    this.timeout(240000)
    // One domain fact — where the authoring document lives — carried by one
    // field, and the filter acts on it: two documents in different directories
    // include the same file name and get their own figure. The requests are
    // identical except for docPath, so anything but a faithfully forwarded
    // path renders the same figure twice.
    const firstDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-doc-'))
    const secondDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-doc-'))
    const stamp = randomBytes(4).toString('hex')
    await writeFile(path.join(firstDir, 'figbody.tikz'), `A \\arrow[r, "f${stamp}"] & B`)
    await writeFile(path.join(secondDir, 'figbody.tikz'), `X \\arrow[r, "g${stamp}"] & Y \\arrow[r, "h${stamp}"] & Z`)
    const source = uncachedTikzcd('\\input{figbody.tikz}')

    const fromFirst = await renderTikz(
      { source, kind: 'raw', language: 'tikzcd', docPath: path.join(firstDir, 'figures.md') },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    const fromSecond = await renderTikz(
      { source, kind: 'raw', language: 'tikzcd', docPath: path.join(secondDir, 'notes.md') },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )
    await rm(firstDir, { recursive: true, force: true })
    await rm(secondDir, { recursive: true, force: true })

    if (!toolchainPresent) {
      assert.ok(!fromFirst.ok && fromFirst.kind === 'missing-tools')
      assert.ok(!fromSecond.ok && fromSecond.kind === 'missing-tools')
      return
    }

    assert.ok(fromFirst.ok, `the first document's include resolves, got ${JSON.stringify(fromFirst).slice(0, 400)}`)
    assert.ok(fromSecond.ok, `the second document's include resolves, got ${JSON.stringify(fromSecond).slice(0, 400)}`)
    if (fromFirst.ok && fromSecond.ok) {
      // The filter namespaces every id in a figure with a hash of that
      // figure's own content, so two different bodies cannot share a prefix.
      const firstPrefix = fromFirst.html.match(/id="([0-9a-f]{8})-/)?.[1]
      const secondPrefix = fromSecond.html.match(/id="([0-9a-f]{8})-/)?.[1]
      assert.ok(firstPrefix !== undefined && secondPrefix !== undefined, 'both renders carry content-hash namespaced ids')
      assert.notStrictEqual(
        firstPrefix,
        secondPrefix,
        'each document contributed its own figure body, so the two renders are different figures'
      )
    }
  })

  it('keeps identical source in different document roots in distinct filter-cache entries', async function () {
    this.timeout(180000)
    const firstDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-cache-root-'))
    const secondDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-cache-root-'))
    const source = uncachedTikzcd('A \\arrow[r, "same-source"] & B')
    const before = new Set(readdirSync(cacheDir).filter(name => /^dzgtikz-.*\.svg$/.test(name)))
    try {
      const first = await renderTikz(
        { source, kind: 'raw', language: 'tikzcd', docPath: path.join(firstDir, 'notes.md') },
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
      )
      const second = await renderTikz(
        { source, kind: 'raw', language: 'tikzcd', docPath: path.join(secondDir, 'notes.md') },
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
      )
      if (!toolchainPresent) {
        assert.ok(!first.ok && first.kind === 'missing-tools')
        assert.ok(!second.ok && second.kind === 'missing-tools')
        return
      }
      assert.ok(first.ok && second.ok, 'both document-root renders succeed')
      const generated = readdirSync(cacheDir)
        .filter(name => /^dzgtikz-.*\.svg$/.test(name) && !before.has(name))
      assert.strictEqual(
        generated.length,
        2,
        'docPath contributes to the filter cache because unresolved relative TeX assets resolve from that root'
      )
    } finally {
      await rm(firstDir, { recursive: true, force: true })
      await rm(secondDir, { recursive: true, force: true })
    }
  })

  it('reports a render killed by a signal as its own outcome naming the signal, not as a pandoc diagnostic', async function () {
    this.timeout(240000)
    if (!toolchainPresent) {
      const result = await renderTikz(
        { source: TIKZCD_OK, kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
        { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
      )
      assert.ok(!result.ok && result.kind === 'missing-tools', 'without the toolchain the typed missing-tools result is required')
      return
    }

    const scratchBefore = new Set(filterScratchDirs())
    const runningBefore = new Set(filterProcessPids())
    // A real render of an uncached figure: pandoc runs the filter, which runs
    // pdflatex, so the process is alive long enough to be signalled.
    const pending = renderTikz(
      { source: uncachedTikzcd('A \\arrow[r] & B'), kind: 'raw', language: 'tikzcd', docPath: NO_DOC_PATH },
      { tikzAssetDir: TIKZ_ASSET_DIR, templatePath: TIKZ_TEMPLATE, cacheDir, env: process.env }
    )

    let signalled = 0
    for (let round = 0; round < 2000 && signalled === 0; round++) {
      // Only the process this render started: an unrelated pandoc dying would
      // prove nothing about this request's outcome.
      for (const pid of filterProcessPids().filter(pid => !runningBefore.has(pid))) {
        process.kill(pid, 'SIGTERM')
        signalled++
      }
      if (signalled === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    assert.ok(signalled > 0, 'the render must actually spawn a pandoc process for this proof to mean anything')

    const result = await pending

    // pdflatex outlives the pandoc process it was launched from; its scratch
    // directory is normally removed by the filter, which never got to run.
    for (const entry of filterScratchDirs()) {
      if (!scratchBefore.has(entry)) {
        await rm(path.join(tmpdir(), entry), { recursive: true, force: true })
      }
    }

    assert.ok(!result.ok, 'a killed render never produced a figure')
    if (!result.ok) {
      assert.strictEqual(result.kind, 'render-terminated', `a signal kill is its own outcome, got ${JSON.stringify(result).slice(0, 400)}`)
      if (result.kind === 'render-terminated') {
        assert.strictEqual(result.signal, 'SIGTERM', 'the signal that ended the render is carried, not discarded')
      }
    }
  })

  it('uses an explicitly configured TikZ data directory', async function () {
    const configuredDir = path.join(cacheDir, 'configured-pandoc')
    await mkdir(path.join(configuredDir, 'filters'), { recursive: true })
    await writeFile(path.join(configuredDir, 'filters/tikzcd.lua'), '-- ZETTLR_TIKZ_RENDER_PROTOCOL=3\n-- configured filter\n')
    await writeFile(path.join(configuredDir, 'filters/utilities.lua'), '-- configured utilities\n')

    assert.strictEqual(
      resolveTikzDataDir(configuredDir, path.join(cacheDir, 'home')),
      configuredDir,
      'an explicit filter tree needs no duplicate standalone template'
    )
  })

  it('defaults to the live ~/.pandoc tree when it carries the TikZ assets', async function () {
    const homeDir = path.join(cacheDir, 'home')
    const userPandocDir = path.join(homeDir, '.pandoc')
    await mkdir(path.join(userPandocDir, 'filters'), { recursive: true })
    await mkdir(path.join(userPandocDir, 'templates'), { recursive: true })
    await writeFile(path.join(userPandocDir, 'filters/tikzcd.lua'), '-- ZETTLR_TIKZ_RENDER_PROTOCOL=3\n-- live user filter\n')
    await writeFile(path.join(userPandocDir, 'filters/utilities.lua'), '-- live user utilities\n')
    await writeFile(path.join(userPandocDir, 'templates/standalone-tikz.tex'), '% live user template\n')

    assert.strictEqual(
      resolveTikzDataDir('', homeDir),
      userPandocDir,
      'the maintained user checkout wins without copying it into the application'
    )
  })

  it('requires the user-owned ~/.pandoc standalone template for live preview', async function () {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'zettlr-tikz-template-home-'))
    try {
      assert.throws(
        () => resolveTikzTemplatePath(homeDir),
        /\.pandoc.*standalone-tikz\.tex/,
        'the preview does not silently substitute a bundled preamble when the owned template is absent'
      )

      const template = path.join(homeDir, '.pandoc', 'templates', 'standalone-tikz.tex')
      await mkdir(path.dirname(template), { recursive: true })
      await writeFile(template, '% owned template\n<>\n')
      assert.strictEqual(resolveTikzTemplatePath(homeDir), template)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('fails loudly instead of substituting a bundled TikZ filter when the shared data tree is absent', function () {
    assert.throws(
      () => resolveTikzDataDir('', path.join(cacheDir, 'home-without-pandoc')),
      /shared Pandoc data tree.*filters\/tikzcd\.lua/,
      'missing shared Pandoc machinery is a startup/configuration defect, not a cue to fork filter behavior'
    )
  })
})
