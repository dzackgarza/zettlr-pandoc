/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Quarto editor citation resolution and startup race proof
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Drives the real CiteprocProvider against real .bib fixtures
 *                  and real CodeMirror EditorViews to prove:
 *                  1. When resolving a nested chapter before the workspace walk
 *                     completes, an empty descriptor map defaults to CITEPROC_MAIN_DB.
 *                  2. Real CiteprocProvider cannot resolve @Stacks under CITEPROC_MAIN_DB,
 *                     rendering .citeproc-citation.error in the live editor DOM.
 *                  3. When Quarto project bibliographies are resolved and applied,
 *                     CiteprocProvider returns the formatted citation from web.bib,
 *                     and the live widget updates cleanly without .error.
 *
 * END HEADER
 */

import './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import path from 'path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderCitations } from 'source/common/modules/markdown-editor/renderers/render-citations'
import {
  configField,
  configUpdateEffect,
  getDefaultConfig
} from 'source/common/modules/markdown-editor/util/configuration'
import {
  getBibliographyForDescriptor,
  resolveProjectForDescriptor,
  resolveProjectForDescriptorSync
} from 'source/common/util/get-bibliography-for-descriptor'
import { parse as parseDirectory } from 'source/app/service-providers/fsal/fsal-directory'
import CiteprocProvider, { type CiteprocConfig, type CiteprocErrorDisplay } from 'source/app/service-providers/citeproc'
import LogProvider from 'source/app/service-providers/log'
import { CITEPROC_MAIN_DB, type CitationDatabase } from 'source/types/common/citeproc'
import type { AnyDescriptor, MDFileDescriptor } from 'source/types/common/fsal'

const CHICAGO_STYLE = path.resolve('static', 'csl-styles', 'chicago-author-date.csl')

function polyfillJsdomForCodeMirror (): void {
  const global = globalThis as any
  if (typeof global.requestAnimationFrame !== 'function') {
    global.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0)
    global.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof global.window === 'object' && typeof global.window.requestAnimationFrame !== 'function') {
    global.window.requestAnimationFrame = global.requestAnimationFrame
    global.window.cancelAnimationFrame = global.cancelAnimationFrame
  }
  if (typeof global.ResizeObserver !== 'function') {
    global.ResizeObserver = class {
      observe () {}
      unobserve () {}
      disconnect () {}
    }
    if (typeof global.window === 'object') {
      global.window.ResizeObserver = global.ResizeObserver
    }
  }
  if (typeof global.Range?.prototype.getClientRects !== 'function') {
    global.Range.prototype.getClientRects = () => []
    global.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }
}

describe('Quarto editor citation resolution and startup race', function () {
  const ROOT = path.resolve('test', 'fixtures', 'quarto-book')
  const views: EditorView[] = []
  let citeproc: CiteprocProvider
  const originalCitationCallback = (globalThis as any).window?.getCitationCallback

  const chapterDescriptor: MDFileDescriptor = {
    path: path.join(ROOT, 'foundations', 'categories.md'),
    name: 'categories.md',
    dir: path.join(ROOT, 'foundations'),
    type: 'file',
    ext: '.md',
    modtime: 1000,
    creationtime: 1000,
    size: 100,
    tags: [],
    links: [],
    citekeys: ['Stacks'],
    yamlTitle: undefined,
    firstHeading: null,
    frontmatter: null,
    bom: '',
    linefeed: '\n',
    wordCount: 10,
    charCount: 50,
    id: 'test-id',
    references: {
      documentPath: path.join(ROOT, 'foundations', 'categories.md'),
      sourceHash: 'test-hash',
      definitions: [],
      occurrences: []
    }
  }

  before(async function () {
    polyfillJsdomForCodeMirror()

    const log = new LogProvider()
    const config: CiteprocConfig = {
      on: () => {},
      get: () => ({ appLang: 'en-US', export: { cslLibrary: '', cslStyle: CHICAGO_STYLE } })
    }
    const windows: CiteprocErrorDisplay = { showErrorMessage: () => {} }

    citeproc = new CiteprocProvider(log, config, windows)
    await citeproc.boot()
    await citeproc.synchronizeDatabases([
      path.join(ROOT, 'references.bib'),
      path.join(ROOT, 'web.bib')
    ])

    // Wire the real CiteprocProvider into window.getCitationCallback
    ;(globalThis as any).window.getCitationCallback = (database: CitationDatabase) => {
      return (citations: any[], composite: boolean) => {
        return citeproc.getCitation(database, citations, composite)
      }
    }
  })

  after(async function () {
    if (citeproc) {
      await citeproc.shutdown()
    }
    if ((globalThis as any).window) {
      ;(globalThis as any).window.getCitationCallback = originalCitationCallback
    }
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (doc: string, library: CitationDatabase): EditorView {
    const config = getDefaultConfig()
    config.metadata.library = library
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownParser(),
        configField.init(() => config),
        renderCitations
      ]
    })
    const view = new EditorView({ state, parent: document.body })
    views.push(view)
    return view
  }

  it('reproduces startup failure: empty descriptor map falls back to CITEPROC_MAIN_DB', function () {
    const emptyMap = new Map<string, AnyDescriptor>()
    const project = resolveProjectForDescriptorSync(chapterDescriptor, emptyMap)
    assert.strictEqual(project, null, 'synchronous lookup on empty map returns null')

    const databases = getBibliographyForDescriptor(chapterDescriptor, project)
    assert.strictEqual(databases, CITEPROC_MAIN_DB, 'empty map causes fallback to CITEPROC_MAIN_DB')
  })

  it('resolves Quarto project bibliographies when descriptor map is populated', async function () {
    const rootDescriptor = await parseDirectory(ROOT)
    const foundationsDescriptor = await parseDirectory(path.join(ROOT, 'foundations'))

    const populatedMap = new Map<string, AnyDescriptor>([
      [rootDescriptor.path, rootDescriptor],
      [foundationsDescriptor.path, foundationsDescriptor]
    ])

    const project = resolveProjectForDescriptorSync(chapterDescriptor, populatedMap)
    assert.notStrictEqual(project, null, 'nested chapter resolves project from populated descriptor map')
    assert.strictEqual(project?.manifest.kind, 'quarto')

    const databases = getBibliographyForDescriptor(chapterDescriptor, project)
    assert.deepStrictEqual(databases, [
      path.join(ROOT, 'references.bib'),
      path.join(ROOT, 'web.bib'),
      CITEPROC_MAIN_DB
    ])
  })

  it('resolves Quarto project asynchronously before workspace walk completes', async function () {
    const rootDescriptor = await parseDirectory(ROOT)
    const foundationsDescriptor = await parseDirectory(path.join(ROOT, 'foundations'))

    const directoryDb = new Map<string, AnyDescriptor>([
      [rootDescriptor.path, rootDescriptor],
      [foundationsDescriptor.path, foundationsDescriptor]
    ])

    // Empty workspaceStore descriptorMap simulating boot race
    const emptyMap = new Map<string, AnyDescriptor>()

    // Async fallback querying FSAL
    const fsalLookup = async (dirPath: string) => directoryDb.get(dirPath)

    const project = await resolveProjectForDescriptor(chapterDescriptor, emptyMap, fsalLookup)
    assert.notStrictEqual(project, null, 'async resolution traverses parent directories to find Quarto project')
    assert.strictEqual(project?.manifest.kind, 'quarto')

    const databases = getBibliographyForDescriptor(chapterDescriptor, project)
    assert.deepStrictEqual(databases, [
      path.join(ROOT, 'references.bib'),
      path.join(ROOT, 'web.bib'),
      CITEPROC_MAIN_DB
    ])
  })

  it('proves citation widget fails under CITEPROC_MAIN_DB but resolves under project bibliographies with real CiteprocProvider', function () {
    const expectedQuartoBibs = [
      path.join(ROOT, 'references.bib'),
      path.join(ROOT, 'web.bib'),
      CITEPROC_MAIN_DB
    ]

    // Mount editor with fallback CITEPROC_MAIN_DB (boot race condition)
    const view = createEditor('See [@Stacks] for details.', CITEPROC_MAIN_DB)

    const initialCitation = view.dom.querySelector('.citeproc-citation')
    assert.notStrictEqual(initialCitation, null, 'citation widget must mount in editor DOM')
    assert.ok(
      initialCitation?.classList.contains('error'),
      'citation @Stacks must have .error class under CITEPROC_MAIN_DB'
    )

    // Simulate workspace descriptors arriving: update editor options with resolved project bibliographies
    view.dispatch({
      effects: configUpdateEffect.of({
        metadata: {
          path: chapterDescriptor.path,
          id: chapterDescriptor.id,
          library: expectedQuartoBibs
        }
      })
    })

    const updatedCitation = view.dom.querySelector('.citeproc-citation')
    assert.notStrictEqual(updatedCitation, null, 'citation widget must exist after update')
    assert.ok(
      !updatedCitation?.classList.contains('error'),
      'citation @Stacks must NOT have .error class once Quarto bibliographies are applied'
    )
    assert.strictEqual(updatedCitation?.textContent, '(“The Stacks Project,” n.d.)')
  })
})
