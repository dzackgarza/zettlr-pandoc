/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        References provider Electron shell specs (issues #1, #53)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the ReferenceProvider shell contract under the
 *                  issue #53 ownership model: constructing the provider
 *                  registers the 'reference-provider' ipcMain handler
 *                  (recorded, not simulated, by the headless harness)
 *                  serving exactly 'get-snapshot'; boot() subscribes to the
 *                  injected FSAL seam's 'fsal-event' stream; and the LIVE
 *                  side is fed by the document authority through the
 *                  reportAuthorityBuffer()/dropAuthorityBuffer() drive
 *                  surface — debounced through the injected scheduler and
 *                  extracted in MAIN from the authority's CURRENT buffer
 *                  text. The FSAL seam is a REAL EventEmitter injected
 *                  through the constructor (the same dependency-injection
 *                  shape LinkProvider uses); the authority seam is a real
 *                  mutable map standing at the exact readMarkdownBufferContent
 *                  seam the documents provider implements.
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
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import type { MDFileDescriptor } from 'source/types/common/fsal'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const OTHER_PAPER_PATH = path.join(FIXTURE_ROOT, 'ProjectB', 'Other_Paper.md')
const STANDALONE_PATH = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

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

/** One recorded, manually-fired scheduled task of the fake scheduler. */
interface RecordedTask {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

/**
 * The injected deferred-execution seam: records every scheduled extraction
 * so the specs prove the debounce (nothing fires by itself) and fire the
 * callbacks deterministically without wall-clock waits.
 */
function makeScheduler (): { tasks: RecordedTask[], schedule: (callback: () => void, delayMs: number) => { cancel: () => void } } {
  const tasks: RecordedTask[] = []
  return {
    tasks,
    schedule: (callback, delayMs) => {
      const task: RecordedTask = { callback, delayMs, cancelled: false }
      tasks.push(task)
      return { cancel: () => { task.cancelled = true } }
    }
  }
}

/** Fires every not-yet-cancelled recorded task, in schedule order. */
function firePending (tasks: RecordedTask[]): void {
  const pending = tasks.splice(0)
  for (const task of pending) {
    if (!task.cancelled) {
      task.callback()
    }
  }
}

describe('References provider Electron shell', function () {
  // A minimal REAL event emitter standing at the exact seam the provider
  // consumes (FSAL's on('fsal-event', …) subscription surface), plus a real
  // mutable map standing at the document authority's
  // readMarkdownBufferContent seam. This is dependency injection of real
  // collaborators, not a mock of provider behavior.
  const fsalSeam = new EventEmitter()
  const authorityBuffers = new Map<string, string>()
  const scheduler = makeScheduler()
  let provider: ReferenceProvider

  before(async function () {
    provider = new ReferenceProvider(
      new LogProvider(),
      fsalSeam,
      { readMarkdownBufferContent: (filePath: string) => authorityBuffers.get(filePath) },
      { schedule: scheduler.schedule }
    )
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

  it('rejects the retired renderer report channel — no renderer→main channel carries document state (issue #53)', function () {
    // The pre-#53 'report-live-buffer'/'drop-live-buffer' commands are gone
    // by design: a renderer (or a stale preload bundle) attempting to
    // report document-derived state must fail loudly, never silently feed
    // a second ownership path.
    assert.throws(
      () => referenceHandler()(undefined, {
        command: 'report-live-buffer',
        payload: { snapshot: extractReferences(THEOREMS_PATH, ''), generation: 1 }
      }),
      Error
    )
    assert.throws(
      () => referenceHandler()(undefined, {
        command: 'drop-live-buffer',
        payload: { documentPath: THEOREMS_PATH }
      }),
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

  it('debounces an authority report and extracts the CURRENT authority text when the debounce fires', async function () {
    const staleContent = [
      '::: {.lemma #lem:stale:draft}',
      'This intermediate draft must never be served.',
      ':::',
      ''
    ].join('\n')
    const liveContent = [
      '::: {.lemma #lem:kodaira:embedding}',
      'The live buffer rewrites the lemma before saving.',
      ':::',
      '',
      '::: {.lemma #lem:live:only}',
      'This definition exists only in the open editor buffer.',
      ':::',
      ''
    ].join('\n')

    // Two rapid authority changes: the second RESCHEDULES (cancelling the
    // first task), and nothing is extracted before a task fires.
    authorityBuffers.set(THEOREMS_PATH, staleContent)
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    authorityBuffers.set(THEOREMS_PATH, liveContent)
    provider.reportAuthorityBuffer(THEOREMS_PATH)

    let state = await getSnapshotOverIpc()
    assert.strictEqual(
      state.resolutions.get('lem:live:only'),
      undefined,
      'nothing may be extracted before the debounce window elapses'
    )

    firePending(scheduler.tasks)

    state = await getSnapshotOverIpc()
    const theorems = state.snapshots.filter(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.strictEqual(theorems.length, 1, 'exactly one snapshot per document: the overlay REPLACES the saved snapshot')
    assert.deepStrictEqual(
      theorems[0],
      extractReferences(THEOREMS_PATH, liveContent),
      'the overlay must be the shared-extractor snapshot of the authority text CURRENT at fire time'
    )
    assert.strictEqual(
      state.resolutions.get('lem:stale:draft'),
      undefined,
      'the cancelled first schedule must never surface its intermediate content'
    )

    const liveOnly = state.resolutions.get('lem:live:only')
    assert.ok(liveOnly !== undefined, 'a definition authored only in the live buffer must resolve')
    assert.strictEqual(liveOnly.status, 'resolved')
  })

  it('serves the citing occurrences of a loaded document FSAL never indexed (issue #46 boundary)', async function () {
    // The real-app first-load defect behind issue #46: the document
    // authority holds an open buffer that no FSAL event ever described, so
    // the pre-#53 merged view had NO snapshot for it and the overlay's
    // citing-locations lookup came up empty. Under the authority-fed model
    // the load itself feeds the merged view.
    const content = [
      '# Terminology, notation, and standard background {#sec:terminology}',
      '',
      'Some prose, see @sec:terminology and the bibliography.',
      ''
    ].join('\n')
    authorityBuffers.set(STANDALONE_PATH, content)
    provider.reportAuthorityBuffer(STANDALONE_PATH, true)
    assert.strictEqual(
      scheduler.tasks[scheduler.tasks.length - 1].delayMs,
      0,
      'a load is a single event: it must not wait out the typing debounce (issue #46 first-load click)'
    )
    firePending(scheduler.tasks)

    const state = await getSnapshotOverIpc()
    const citing = state.snapshots
      .flatMap(snapshot => snapshot.occurrences)
      .filter(occurrence => occurrence.key === 'sec:terminology')
    assert.strictEqual(citing.length, 1, 'the open buffer\'s citing occurrence must be part of the merged view')
    assert.strictEqual(citing[0].documentPath, STANDALONE_PATH)
    assert.strictEqual(citing[0].clusterRaw, '@sec:terminology')

    provider.dropAuthorityBuffer(STANDALONE_PATH)
    authorityBuffers.delete(STANDALONE_PATH)
  })

  it('resolves a fired report against the authority open set: a buffer closed mid-debounce drops instead of serving', async function () {
    // The change is reported, then the document closes before the debounce
    // fires. The extraction reads the authority at FIRE time, finds the
    // buffer gone, and the overlay follows the open set — stale content
    // from schedule time must never be served.
    authorityBuffers.set(THEOREMS_PATH, '::: {.lemma #lem:ghost:buffer}\nGone before the debounce fired.\n:::\n')
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    authorityBuffers.delete(THEOREMS_PATH)

    firePending(scheduler.tasks)

    const state = await getSnapshotOverIpc()
    assert.strictEqual(
      state.resolutions.get('lem:ghost:buffer'),
      undefined,
      'a buffer closed before the debounce fired must not surface an overlay'
    )
    const theorems = state.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.deepStrictEqual(
      theorems,
      extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8')),
      'the document reverts to its saved FSAL snapshot'
    )
  })

  it('dropAuthorityBuffer removes the served overlay, cancels a pending report, and reverts to the saved snapshot', async function () {
    // Establish a served overlay first.
    const servedContent = '::: {.lemma #lem:served:draft}\nServed before the close.\n:::\n'
    authorityBuffers.set(THEOREMS_PATH, servedContent)
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    firePending(scheduler.tasks)
    let state = await getSnapshotOverIpc()
    assert.strictEqual(state.resolutions.get('lem:served:draft')?.status, 'resolved', 'precondition: the overlay is served')

    // A further change is pending when the buffer closes: the drop must
    // kill the pending task AND the served overlay, immediately.
    authorityBuffers.set(THEOREMS_PATH, servedContent + '\n::: {.lemma #lem:cancelled:draft}\nCancelled before extraction.\n:::\n')
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    provider.dropAuthorityBuffer(THEOREMS_PATH)
    authorityBuffers.delete(THEOREMS_PATH)
    firePending(scheduler.tasks)

    state = await getSnapshotOverIpc()
    assert.strictEqual(
      state.resolutions.get('lem:cancelled:draft'),
      undefined,
      'a drop must cancel the pending extraction'
    )
    assert.strictEqual(
      state.resolutions.get('lem:served:draft'),
      undefined,
      'the drop must also remove the previously served overlay'
    )
    const savedSnapshot = extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8'))
    const theorems = state.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.ok(theorems !== undefined, 'the saved snapshot must survive dropping the live overlay')
    assert.strictEqual(theorems.sourceHash, savedSnapshot.sourceHash, 'dropping the overlay must revert to the saved content')
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
