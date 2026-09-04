/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CITEPROC_MAIN_DB sentinel resolution specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The CITEPROC_MAIN_DB sentinel names the globally
 *                  configured citation library. `export.cslLibrary` is
 *                  optional and ships empty, so the sentinel has to resolve
 *                  to nothing when no global library is configured, and to
 *                  that library when one is. Driven per the provider-shell
 *                  pattern: the REAL CiteprocProvider loads REAL .bib files
 *                  through its own loader and answers through the REAL
 *                  registered 'citeproc-provider' ipcMain handler -- the same
 *                  channel and 'get-items' command the editor's
 *                  updateCitationKeys() calls for every document it opens.
 *                  Config and the error display are injected as the narrow
 *                  CiteprocConfig / CiteprocErrorDisplay surfaces the provider
 *                  declares, so both doubles implement a complete interface
 *                  and a member added to either fails compilation here. The
 *                  whole ConfigProvider cannot be built headlessly anyway: it
 *                  reads a webpack-copied `lang/` asset directory at
 *                  construction. The config values are its shipped defaults.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import { ipcMainHandlers, userData } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import CiteprocProvider from 'source/app/service-providers/citeproc'
import type { CiteprocConfig, CiteprocErrorDisplay } from 'source/app/service-providers/citeproc'
import LogProvider from 'source/app/service-providers/log'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import type { CitationDatabase } from '@dts/common/citeproc'

/** The style asset the application ships and loads when none is configured. */
const CHICAGO_STYLE = path.resolve('static', 'csl-styles', 'chicago-author-date.csl')

/** The bibliography a Quarto project manifest names. */
const PROJECT_LIBRARY = `@article{Cob19,
  author = {Coble, Arthur B.},
  title = {The ten nodes of the rational sextic and of the Cayley symmetroid},
  year = {1919},
  journaltitle = {American Journal of Mathematics},
}
`

/** The library `export.cslLibrary` points at once the user configures one. */
const GLOBAL_LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`

type IpcHandler = (event: unknown, message: { command: string, payload?: unknown }) => Promise<unknown>|unknown

/** The config surface CiteprocProvider consumes, at its shipped defaults. */
function makeConfigSeam (cslLibrary: string): CiteprocConfig {
  return {
    on: () => {},
    get: () => ({ appLang: 'en-US', export: { cslLibrary, cslStyle: CHICAGO_STYLE } })
  }
}

/**
 * Records the error dialogs the provider raises. An unconfigured global
 * library must resolve quietly: reporting it as a user-facing failure is the
 * same defect wearing a dialog.
 */
interface RecordedDialog { title: string, message: string }

function makeWindowRecorder (): { dialogs: RecordedDialog[], display: CiteprocErrorDisplay } {
  const dialogs: RecordedDialog[] = []
  return {
    dialogs,
    display: {
      showErrorMessage: (title: string, message: string) => { dialogs.push({ title, message }) }
    }
  }
}

function handler (): IpcHandler {
  const registered = ipcMainHandlers.get('citeproc-provider') as IpcHandler|undefined
  assert.ok(registered !== undefined, 'constructing CiteprocProvider must register the citeproc-provider handler')
  return registered
}

async function citekeysFor (database: CitationDatabase): Promise<string[]> {
  const items = await handler()(undefined, {
    command: 'get-items',
    payload: { database }
  }) as CSLItem[]
  return items.map(item => item.id).sort()
}

describe('CITEPROC_MAIN_DB sentinel', function () {
  let directory: string
  let projectLibraryPath: string
  let globalLibraryPath: string
  const log = new LogProvider()

  before(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), 'zettlr-citeproc-sentinel-'))
    projectLibraryPath = path.join(directory, 'project.bib')
    globalLibraryPath = path.join(directory, 'global.bib')
    writeFileSync(projectLibraryPath, PROJECT_LIBRARY)
    writeFileSync(globalLibraryPath, GLOBAL_LIBRARY)
    // A parse cache left by an earlier run would answer for a library this
    // run never wrote.
    rmSync(path.join(userData, 'citeproc-cache'), { recursive: true, force: true })
  })

  after(function () {
    rmSync(directory, { recursive: true, force: true })
  })

  describe('with no global library configured', function () {
    let provider: CiteprocProvider
    let dialogs: RecordedDialog[]

    before(async function () {
      const windows = makeWindowRecorder()
      dialogs = windows.dialogs
      provider = new CiteprocProvider(log, makeConfigSeam(''), windows.display)
      await provider.boot()
    })

    after(async function () {
      await provider.shutdown()
    })

    it('serves an empty item set for a document carrying no library of its own', async function () {
      assert.deepEqual(await citekeysFor(CITEPROC_MAIN_DB), [])
      assert.deepEqual(dialogs, [])
    })

    it('serves a project bibliography without the unconfigured global library', async function () {
      assert.deepEqual(
        await citekeysFor([ projectLibraryPath, CITEPROC_MAIN_DB ]),
        ['Cob19']
      )
      assert.deepEqual(dialogs, [])
    })
  })

  describe('with a global library configured', function () {
    let provider: CiteprocProvider

    before(async function () {
      provider = new CiteprocProvider(
        log,
        makeConfigSeam(globalLibraryPath),
        makeWindowRecorder().display
      )
      await provider.boot()
    })

    after(async function () {
      await provider.shutdown()
    })

    it('merges the global library into a project bibliography', async function () {
      assert.deepEqual(
        await citekeysFor([ projectLibraryPath, CITEPROC_MAIN_DB ]),
        [ 'Cob19', 'Nik80' ]
      )
    })

    it('resolves the bare sentinel to the global library', async function () {
      assert.deepEqual(await citekeysFor(CITEPROC_MAIN_DB), ['Nik80'])
    })
  })
})
