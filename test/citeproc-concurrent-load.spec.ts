/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Concurrent citation database requests
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Each window asks for the items of a citation database when
 *                  it opens a document, so several requests for one database
 *                  arrive before its first load ends. The provider answers
 *                  all of them from one load: every request receives the same
 *                  item objects, which the cluster-wide disambiguation of
 *                  citeproc requires. The REAL CiteprocProvider loads a REAL
 *                  .bib file and answers through its registered
 *                  'citeproc-provider' handler.
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
import LogProvider from 'source/app/service-providers/log'

const CHICAGO_STYLE = path.resolve('static', 'csl-styles', 'chicago-author-date.csl')

const LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`

type IpcHandler = (event: undefined, message: { command: 'get-items', payload: { database: string } }) => Promise<CSLItem[]>

describe('Concurrent requests for one citation database', function () {
  let directory: string
  let libraryPath: string
  let provider: CiteprocProvider

  before(async function () {
    directory = mkdtempSync(path.join(os.tmpdir(), 'zettlr-citeproc-concurrent-'))
    libraryPath = path.join(directory, 'library.bib')
    writeFileSync(libraryPath, LIBRARY)
    // Without a parse cache each load parses the file.
    rmSync(path.join(userData, 'citeproc-cache'), { recursive: true, force: true })
    provider = new CiteprocProvider(
      new LogProvider(),
      { on: () => {}, get: () => ({ appLang: 'en-US', export: { cslLibrary: '', cslStyle: CHICAGO_STYLE } }) },
      { showErrorMessage: (title: string, message: string) => { throw new Error(`${title}: ${message}`) } }
    )
    await provider.boot()
  })

  after(async function () {
    await provider.shutdown()
    rmSync(directory, { recursive: true, force: true })
  })

  it('gives each request the item objects of one load', async function () {
    const handler = ipcMainHandlers.get('citeproc-provider') as IpcHandler
    const request = { command: 'get-items' as const, payload: { database: libraryPath } }
    const [ first, second, third ] = await Promise.all([
      handler(undefined, request),
      handler(undefined, request),
      handler(undefined, request)
    ])
    assert.deepEqual(first.map(item => item.id), ['Nik80'])
    assert.equal(second[0], first[0])
    assert.equal(third[0], first[0])
    assert.equal(provider.getItem(libraryPath, 'Nik80'), first[0])
  })
})
