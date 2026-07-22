/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        References provider Electron shell specs (issue #1, Phase 3b red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the ReferenceProvider shell contract: constructing
 *                  the provider registers the 'reference-provider' ipcMain
 *                  handler (recorded, not simulated, by the headless
 *                  harness), boot() subscribes to the injected FSAL seam's
 *                  'fsal-event' stream, and every ipc command delegates 1:1
 *                  to the pure ReferenceIndex. The FSAL seam is a REAL
 *                  EventEmitter injected through the constructor (the same
 *                  dependency-injection shape LinkProvider uses); the spec
 *                  emits real FSAL event payloads carrying descriptors whose
 *                  references were produced by the real extractor over the
 *                  reference-workspace fixture.
 *
 * END HEADER
 */

// The harness must load before any provider module: LogProvider imports
// 'electron' at module scope.
import { ipcMainHandlers } from './headless-electron-harness.cjs'
import assert from 'assert'
import EventEmitter from 'events'
import { readFileSync } from 'fs'
import path from 'path'
import ReferenceProvider from 'source/app/service-providers/references'
import LogProvider from 'source/app/service-providers/log'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import type FSAL from 'source/app/service-providers/fsal'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import type { DocumentReferenceSnapshot } from '@dts/common/references'
import type { MDFileDescriptor } from 'source/types/common/fsal'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const OTHER_PAPER_PATH = path.join(FIXTURE_ROOT, 'ProjectB', 'Other_Paper.md')

type IpcInvoke = (event: unknown, message: { command: string, payload?: unknown }) => Promise<unknown>|unknown

/**
 * Builds the real markdown descriptor FSAL would emit for a fixture file:
 * the references snapshot comes from the same shared extractor FSAL's
 * file parser delegates to (proven by test/fsal-reference-snapshots.spec.ts).
 */
function makeDescriptor (documentPath: string): MDFileDescriptor {
  const content = readFileSync(documentPath, 'utf-8')
  return {
    dir: path.dirname(documentPath),
    path: documentPath,
    name: path.basename(documentPath),
    ext: path.extname(documentPath),
    size: content.length,
    id: '',
    tags: [],
    links: [],
    citekeys: [],
    bom: '',
    type: 'file',
    wordCount: 0,
    charCount: 0,
    modtime: 0,
    creationtime: 0,
    linefeed: '\n',
    firstHeading: null,
    yamlTitle: undefined,
    frontmatter: null,
    references: extractReferences(documentPath, content)
  }
}

describe('References provider Electron shell', function () {
  // A minimal REAL event emitter standing at the exact seam the provider
  // consumes (FSAL's on('fsal-event', …) subscription surface). This is
  // dependency injection of a real emitter, not a mock of FSAL behavior:
  // events emitted here are real 'fsal-event' payloads.
  const fsalSeam = new EventEmitter()
  let provider: ReferenceProvider

  before(async function () {
    provider = new ReferenceProvider(new LogProvider(), fsalSeam as unknown as FSAL)
    await provider.boot()
  })

  after(async function () {
    await provider.shutdown()
  })

  function referenceHandler (): IpcInvoke {
    const handler = ipcMainHandlers.get('reference-provider') as IpcInvoke|undefined
    assert.ok(
      handler !== undefined,
      'constructing ReferenceProvider must register the reference-provider ipcMain handler (LinkProvider pattern)'
    )
    return handler
  }

  async function getSnapshotOverIpc (): Promise<WorkspaceReferenceState> {
    const state = await referenceHandler()(undefined, { command: 'get-snapshot' })
    return state as WorkspaceReferenceState
  }

  it('registers the reference-provider ipc handler on construction', function () {
    referenceHandler()
  })

  it('throws on a command outside the delegation map instead of answering undefined (issue #5, B20)', function () {
    // Fail-loud contract: an unknown command is a caller bug. Reverting the
    // handler to the silent fall-through makes this call return undefined
    // and the assertion fail.
    assert.throws(
      () => referenceHandler()(undefined, { command: 'no-such-reference-command' }),
      Error
    )
  })

  it('applies FSAL change-event snapshots so get-snapshot serves the workspace definitions', async function () {
    fsalSeam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(THEOREMS_PATH) })
    fsalSeam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(OTHER_PAPER_PATH) })

    const state = await getSnapshotOverIpc()
    const theorems = state.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.ok(theorems !== undefined, 'the Theorems.md saved snapshot must be part of the merged workspace state')
    assert.deepStrictEqual(
      theorems,
      extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8')),
      'the served snapshot must be exactly the FSAL-extracted snapshot for Theorems.md'
    )

    const kodaira = state.resolutions.get('lem:kodaira:embedding')
    assert.ok(kodaira !== undefined, 'lem:kodaira:embedding must resolve in the merged workspace')
    assert.strictEqual(kodaira.status, 'resolved')
    assert.strictEqual(kodaira.status === 'resolved' ? kodaira.definition.documentPath : undefined, THEOREMS_PATH)

    // thm:torelli is defined in BOTH fixture documents: the workspace
    // resolution must retain every definition, never silently pick one.
    const torelli = state.resolutions.get('thm:torelli')
    assert.ok(torelli !== undefined, 'thm:torelli must be resolved in the merged workspace')
    assert.strictEqual(torelli.status, 'duplicate')
    assert.strictEqual(torelli.status === 'duplicate' ? torelli.definitions.length : 0, 2)
  })

  it('exposes the same merged state through the public getSnapshot() delegation', function () {
    const state = provider.getSnapshot()
    const keys = state.snapshots.flatMap(snapshot => snapshot.definitions.map(definition => definition.key))
    assert.ok(
      keys.includes('lem:kodaira:embedding'),
      'getSnapshot() must delegate to the same ReferenceIndex the ipc surface serves'
    )
  })

  it('report-live-buffer overlays the saved snapshot with the live buffer content', async function () {
    const liveContent = [
      '::: {.lemma #lem:kodaira:embedding}',
      'The live buffer rewrites the lemma before saving.',
      ':::',
      '',
      '::: {.lemma #lem:live:only}',
      'This definition exists only in the unsaved editor buffer.',
      ':::',
      ''
    ].join('\n')
    const liveSnapshot: DocumentReferenceSnapshot = extractReferences(THEOREMS_PATH, liveContent)

    await referenceHandler()(undefined, {
      command: 'report-live-buffer',
      payload: { snapshot: liveSnapshot, generation: 1 }
    })

    const state = await getSnapshotOverIpc()
    const theorems = state.snapshots.filter(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.strictEqual(theorems.length, 1, 'exactly one snapshot per document: the overlay REPLACES the saved snapshot')
    assert.strictEqual(theorems[0].sourceHash, liveSnapshot.sourceHash, 'the live buffer snapshot must be authoritative')

    const liveOnly = state.resolutions.get('lem:live:only')
    assert.ok(liveOnly !== undefined, 'a definition authored only in the live buffer must resolve')
    assert.strictEqual(liveOnly.status, 'resolved')
  })

  it('drop-live-buffer reverts the document to its saved snapshot', async function () {
    await referenceHandler()(undefined, {
      command: 'drop-live-buffer',
      payload: { documentPath: THEOREMS_PATH }
    })

    const state = await getSnapshotOverIpc()
    const savedSnapshot = extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8'))
    const theorems = state.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.ok(theorems !== undefined, 'the saved snapshot must survive dropping the live overlay')
    assert.strictEqual(theorems.sourceHash, savedSnapshot.sourceHash, 'dropping the overlay must revert to the saved content')
    assert.strictEqual(
      state.resolutions.get('lem:live:only'),
      undefined,
      'the buffer-only definition must vanish with its overlay'
    )
  })

  it('removes unlinked documents from the merged state on FSAL unlink events', async function () {
    fsalSeam.emit('fsal-event', { event: 'unlink', path: THEOREMS_PATH })

    const state = await getSnapshotOverIpc()
    assert.strictEqual(state.snapshots.length, 1, 'only Other_Paper.md must remain after unlinking Theorems.md')
    assert.strictEqual(state.snapshots[0].documentPath, OTHER_PAPER_PATH)

    // The unlink dissolves the duplicate: thm:torelli now has exactly one
    // definition and must resolve to Other_Paper.md's.
    const torelli = state.resolutions.get('thm:torelli')
    assert.ok(torelli !== undefined, 'thm:torelli must still resolve from the surviving document')
    assert.strictEqual(torelli.status, 'resolved')
    assert.strictEqual(torelli.status === 'resolved' ? torelli.definition.documentPath : undefined, OTHER_PAPER_PATH)
  })
})
