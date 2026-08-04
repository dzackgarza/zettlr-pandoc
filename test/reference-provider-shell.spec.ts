/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        References provider behavior specs (issues #1, #53)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Exercises saved reference snapshots and authority-buffer
 *                  overlays through the production provider and IPC read
 *                  surface. The cases cover FSAL changes, current-buffer
 *                  extraction, debounce, close-before-fire, drop, and unlink.
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
import type { WorkspaceTextEdit } from '@dts/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const OTHER_PAPER_PATH = path.join(FIXTURE_ROOT, 'ProjectB', 'Other_Paper.md')
const STANDALONE_PATH = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

type IpcInvoke = (event: unknown, message: { command: string, payload?: unknown }) => Promise<unknown>|unknown

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

interface RecordedTask {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

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

function firePending (tasks: RecordedTask[]): void {
  const pending = tasks.splice(0)
  for (const task of pending) {
    if (!task.cancelled) {
      task.callback()
    }
  }
}

function applyAuthorityEdits (
  authorityBuffers: Map<string, string>,
  edits: WorkspaceTextEdit[]
): string[] {
  const editsByDocument = new Map<string, WorkspaceTextEdit[]>()
  for (const edit of edits) {
    const documentEdits = editsByDocument.get(edit.documentPath)
    if (documentEdits === undefined) {
      editsByDocument.set(edit.documentPath, [edit])
    } else {
      documentEdits.push(edit)
    }
  }

  for (const [ documentPath, documentEdits ] of editsByDocument) {
    const content = authorityBuffers.get(documentPath)
    assert(content !== undefined, `Workspace edit names unopened authority buffer ${documentPath}`)
    const ordered = [...documentEdits].sort((a, b) => b.range.from - a.range.from)
    let rewritten = content
    for (const edit of ordered) {
      rewritten = rewritten.slice(0, edit.range.from) + edit.insert + rewritten.slice(edit.range.to)
    }
    authorityBuffers.set(documentPath, rewritten)
  }

  return [...editsByDocument.keys()]
}

describe('References provider behavior', function () {
  let fsalSeam: EventEmitter
  let authorityBuffers: Map<string, string>
  let scheduler: ReturnType<typeof makeScheduler>
  let provider: ReferenceProvider

  beforeEach(async function () {
    fsalSeam = new EventEmitter()
    authorityBuffers = new Map<string, string>()
    scheduler = makeScheduler()
    provider = new ReferenceProvider(
      new LogProvider(),
      fsalSeam,
      {
        readMarkdownBufferContent: (filePath: string) => authorityBuffers.get(filePath),
        applyWorkspaceTextEdits: async (edits: WorkspaceTextEdit[]) => {
          return applyAuthorityEdits(authorityBuffers, edits)
        }
      },
      500,
      { schedule: scheduler.schedule }
    )
    await provider.boot()
    fsalSeam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(THEOREMS_PATH) })
    fsalSeam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(OTHER_PAPER_PATH) })
  })

  afterEach(async function () {
    await provider.shutdown()
  })

  function referenceHandler (): IpcInvoke {
    const handler = ipcMainHandlers.get('reference-provider') as IpcInvoke|undefined
    assert.ok(handler !== undefined, 'reference-provider IPC handler is unavailable')
    return handler
  }

  async function getSnapshotOverIpc (): Promise<WorkspaceReferenceState> {
    const state = await referenceHandler()(undefined, { command: 'get-snapshot' })
    return state as WorkspaceReferenceState
  }

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

    const torelli = state.resolutions.get('thm:torelli')
    assert.ok(torelli !== undefined, 'thm:torelli must be resolved in the merged workspace')
    assert.strictEqual(torelli.status, 'duplicate')
    assert.strictEqual(torelli.status === 'duplicate' ? torelli.definitions.length : 0, 2)
  })

  it('debounces an authority report and extracts the current authority text when the debounce fires', async function () {
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

    authorityBuffers.set(THEOREMS_PATH, staleContent)
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    authorityBuffers.set(THEOREMS_PATH, liveContent)
    provider.reportAuthorityBuffer(THEOREMS_PATH)

    let state = await getSnapshotOverIpc()
    assert.strictEqual(state.resolutions.get('lem:live:only'), undefined)

    firePending(scheduler.tasks)

    state = await getSnapshotOverIpc()
    const theorems = state.snapshots.filter(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.strictEqual(theorems.length, 1)
    assert.deepStrictEqual(theorems[0], extractReferences(THEOREMS_PATH, liveContent))
    assert.strictEqual(state.resolutions.get('lem:stale:draft'), undefined)

    const liveOnly = state.resolutions.get('lem:live:only')
    assert.ok(liveOnly !== undefined)
    assert.strictEqual(liveOnly.status, 'resolved')
  })

  it('serves the citing occurrences of a loaded document FSAL never indexed', async function () {
    const content = [
      '# Terminology, notation, and standard background {#sec:terminology}',
      '',
      'Some prose, see @sec:terminology and the bibliography.',
      ''
    ].join('\n')
    authorityBuffers.set(STANDALONE_PATH, content)
    provider.reportAuthorityBuffer(STANDALONE_PATH, true)
    assert.strictEqual(scheduler.tasks[scheduler.tasks.length - 1].delayMs, 0)
    firePending(scheduler.tasks)

    const state = await getSnapshotOverIpc()
    const citing = state.snapshots
      .flatMap(snapshot => snapshot.occurrences)
      .filter(occurrence => occurrence.key === 'sec:terminology')
    assert.strictEqual(citing.length, 1)
    assert.strictEqual(citing[0].documentPath, STANDALONE_PATH)
    assert.strictEqual(citing[0].clusterRaw, '@sec:terminology')

    provider.dropAuthorityBuffer(STANDALONE_PATH)
    authorityBuffers.delete(STANDALONE_PATH)
  })

  it('drops a buffer closed before its pending extraction fires', async function () {
    authorityBuffers.set(THEOREMS_PATH, '::: {.lemma #lem:ghost:buffer}\nGone before the debounce fired.\n:::\n')
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    authorityBuffers.delete(THEOREMS_PATH)

    firePending(scheduler.tasks)

    const state = await getSnapshotOverIpc()
    assert.strictEqual(state.resolutions.get('lem:ghost:buffer'), undefined)
    const theorems = state.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.deepStrictEqual(
      theorems,
      extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8'))
    )
  })

  it('dropAuthorityBuffer cancels pending extraction and restores the saved snapshot', async function () {
    const servedContent = '::: {.lemma #lem:served:draft}\nServed before the close.\n:::\n'
    authorityBuffers.set(THEOREMS_PATH, servedContent)
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    firePending(scheduler.tasks)
    let state = await getSnapshotOverIpc()
    assert.strictEqual(state.resolutions.get('lem:served:draft')?.status, 'resolved')

    authorityBuffers.set(THEOREMS_PATH, servedContent + '\n::: {.lemma #lem:cancelled:draft}\nCancelled before extraction.\n:::\n')
    provider.reportAuthorityBuffer(THEOREMS_PATH)
    provider.dropAuthorityBuffer(THEOREMS_PATH)
    authorityBuffers.delete(THEOREMS_PATH)
    firePending(scheduler.tasks)

    state = await getSnapshotOverIpc()
    assert.strictEqual(state.resolutions.get('lem:cancelled:draft'), undefined)
    assert.strictEqual(state.resolutions.get('lem:served:draft'), undefined)
    const savedSnapshot = extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8'))
    const theorems = state.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
    assert.ok(theorems !== undefined)
    assert.strictEqual(theorems.sourceHash, savedSnapshot.sourceHash)
  })

  it('removes unlinked documents from the merged state on FSAL unlink events', async function () {
    fsalSeam.emit('fsal-event', { event: 'unlink', path: THEOREMS_PATH })

    const state = await getSnapshotOverIpc()
    assert.strictEqual(state.snapshots.length, 1)
    assert.strictEqual(state.snapshots[0].documentPath, OTHER_PAPER_PATH)

    const torelli = state.resolutions.get('thm:torelli')
    assert.ok(torelli !== undefined)
    assert.strictEqual(torelli.status, 'resolved')
    assert.strictEqual(torelli.status === 'resolved' ? torelli.definition.documentPath : undefined, OTHER_PAPER_PATH)
  })
})