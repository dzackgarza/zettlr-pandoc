/**
 * Citeproc rendering invariants.
 *
 * A CSL item that exists in the selected database must either produce a real
 * citation/bibliography form or raise a contextual rendering error. Sentinel
 * strings such as [NO_PRINTED_FORM] are never valid renderer output.
 */

import { ipcMainHandlers, userData } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import CiteprocProvider, {
  CiteprocRenderInvariantError,
  type CiteprocConfig,
  type CiteprocErrorDisplay,
} from 'source/app/service-providers/citeproc'
import LogProvider from 'source/app/service-providers/log'

const CHICAGO_STYLE = path.resolve('static', 'csl-styles', 'chicago-author-date.csl')

const AW71_BIB = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
  doi = {10.1016/0040-9383(71)90028-0},
}
`

function style (citationFormat: string, citationBody: string, bibliographyBody = '<text variable="title"/>'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Invariant test style</title>
    <id>https://example.invalid/styles/invariant-test</id>
    <link href="https://example.invalid/styles/invariant-test" rel="self"/>
    <updated>2026-09-19T00:00:00+00:00</updated>
    <category citation-format="${citationFormat}"/>
  </info>
  <citation><layout prefix="[" suffix="]">${citationBody}</layout></citation>
  <bibliography><layout>${bibliographyBody}</layout></bibliography>
</style>`
}

function config (stylePath: string): CiteprocConfig {
  return {
    on: () => {},
    get: () => ({ appLang: 'en-US', export: { cslLibrary: '', cslStyle: stylePath } }),
  }
}

const windows: CiteprocErrorDisplay = { showErrorMessage: () => {} }

describe('Citeproc printable-form invariant', function () {
  let directory: string
  let libraryPath: string
  let labelStylePath: string
  let impossibleStylePath: string
  let impossibleBibliographyStylePath: string
  const log = new LogProvider()

  before(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), 'zettlr-citeproc-invariant-'))
    libraryPath = path.join(directory, 'references.bib')
    labelStylePath = path.join(directory, 'label.csl')
    impossibleStylePath = path.join(directory, 'impossible.csl')
    impossibleBibliographyStylePath = path.join(directory, 'impossible-bibliography.csl')
    writeFileSync(libraryPath, AW71_BIB)
    writeFileSync(labelStylePath, style('label', '<text variable="citation-label"/>'))
    writeFileSync(impossibleStylePath, style('author-date', '<text variable="genre"/>'))
    writeFileSync(
      impossibleBibliographyStylePath,
      style('label', '<text variable="citation-label"/>', '<text variable="genre"/>')
    )
    rmSync(path.join(userData, 'citeproc-cache'), { recursive: true, force: true })
  })

  after(function () {
    rmSync(directory, { recursive: true, force: true })
  })

  async function providerFor (stylePath: string): Promise<CiteprocProvider> {
    const provider = new CiteprocProvider(log, config(stylePath), windows)
    await provider.boot()
    await provider.synchronizeDatabases([libraryPath])
    return provider
  }

  it('uses ordinary citation mode for a label style even when Markdown source is narrative', async function () {
    const provider = await providerFor(labelStylePath)
    try {
      const rendered = provider.getCitation(libraryPath, [{ id: 'AW71' }], true)
      assert.equal(rendered, '[AW71]')
      assert.doesNotMatch(rendered ?? '', /NO_PRINTED_FORM|no printed form/i)
    } finally {
      await provider.shutdown()
    }
  })

  it('keeps native composite rendering for an author-date style', async function () {
    const provider = await providerFor(CHICAGO_STYLE)
    try {
      const rendered = provider.getCitation(libraryPath, [{ id: 'AW71' }], true)
      assert.equal(rendered, 'Artin and Winters (1971)')
    } finally {
      await provider.shutdown()
    }
  })

  it('throws contextual failure when a valid item has no printable citation form', async function () {
    const provider = await providerFor(impossibleStylePath)
    try {
      assert.throws(
        () => provider.getCitation(libraryPath, [{ id: 'AW71' }], true),
        (error: unknown) => {
          assert.ok(error instanceof CiteprocRenderInvariantError)
          assert.match(error.message, /AW71/)
          assert.match(error.message, /impossible\.csl/)
          assert.match(error.message, /citation-format=author-date/)
          assert.doesNotMatch(error.message, /returned.*NO_PRINTED_FORM/)
          return true
        }
      )
    } finally {
      await provider.shutdown()
    }
  })

  it('throws contextual failure when a bibliography item has no printable form', async function () {
    const provider = await providerFor(impossibleBibliographyStylePath)
    try {
      assert.throws(
        () => provider.makeBibliography(libraryPath, ['AW71']),
        (error: unknown) => {
          assert.ok(error instanceof CiteprocRenderInvariantError)
          assert.match(error.message, /bibliography invariant failed.*AW71/)
          assert.match(error.message, /impossible-bibliography\.csl/)
          return true
        }
      )
    } finally {
      await provider.shutdown()
    }
  })

  it('rejects impossible output over async IPC instead of returning a sentinel', async function () {
    const provider = await providerFor(impossibleStylePath)
    try {
      const handler = ipcMainHandlers.get('citeproc-provider') as ((event: unknown, message: unknown) => Promise<unknown>)|undefined
      assert.ok(handler !== undefined)
      await assert.rejects(
        handler(undefined, {
          command: 'get-citation',
          payload: { database: libraryPath, citations: [{ id: 'AW71' }], composite: true },
        }),
        /Citeproc citation invariant failed.*AW71/
      )
    } finally {
      await provider.shutdown()
    }
  })
})
