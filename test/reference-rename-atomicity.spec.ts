/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace rename atomicity specs (issue #1, Phase 6 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the ReferenceProvider rename protocol against a
 *                  SCRATCH COPY of the reference-workspace fixture on disk —
 *                  the committed fixture is never mutated. The rename
 *                  protocol is driven through the PRODUCTION command surface
 *                  (review B7): the 'application' channel's RenameReference
 *                  command ('preview-/commit-/undo-reference-rename')
 *                  delegating to the real provider — the same chain
 *                  MainEditor.vue invokes. Live-buffer plays stay on the
 *                  real 'reference-provider' ipcMain handler (their own
 *                  production path). The provider is constructed exactly
 *                  like production (LogProvider + injected FSAL seam) and
 *                  fed real FSAL event payloads whose snapshots come from
 *                  the real extractor.
 *
 *                  BOUNDARY SPLIT (stated per the red-proof contract): the
 *                  main-process provider owns hash-fencing and CLOSED-FILE
 *                  atomic disk writes. Open buffers remain unsaved, but the
 *                  DOCUMENT AUTHORITY applies their transactions and records
 *                  collab updates for every renderer pane before it
 *                  acknowledges success (issue #53). This spec exercises
 *                  that authority seam through a real mutable buffer map —
 *                  the provider's open-set partition, hash fences, live
 *                  overlay, commit, and undo all read it.
 *
 * END HEADER
 */

// The harness must load before any provider module: LogProvider imports
// 'electron' at module scope.
import { ipcMainHandlers } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import EventEmitter from 'events'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { cp, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import ReferenceProvider from 'source/app/service-providers/references'
import RenameReference from 'source/app/service-providers/commands/rename-reference'
import LogProvider from 'source/app/service-providers/log'
import { extractReferences, hashDocumentSource } from 'source/common/pandoc-util/extract-references'
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome
} from 'source/common/pandoc-util/compute-reference-edits'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import type { MDFileDescriptor } from 'source/types/common/fsal'
import type { WorkspaceReferenceEdit, WorkspaceTextEdit } from '@dts/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const RELATIVE_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectB', 'Other_Paper.md'),
  'Standalone_Notes.md'
]

const OLD_KEY = 'thm:torelli'
const NEW_KEY = 'thm:torelli-enriques'

type IpcInvoke = (event: unknown, message: { command: string, payload?: unknown }) => Promise<unknown>|unknown

/** The real registered 'reference-provider' handler, from the harness. */
function referenceHandler (): IpcInvoke {
  const handler = ipcMainHandlers.get('reference-provider') as IpcInvoke|undefined
  assert.ok(handler !== undefined, 'constructing ReferenceProvider must register the reference-provider handler')
  return handler
}

async function invoke (command: string, payload?: unknown): Promise<unknown> {
  return await referenceHandler()(undefined, { command, payload })
}

/** Builds the real markdown descriptor FSAL would emit for a scratch file. */
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

/** Renderer/disk application oracle (descending by range start). */
function applyEdits (source: string, edits: WorkspaceTextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.range.from - a.range.from)
  let result = source
  for (const edit of ordered) {
    result = result.slice(0, edit.range.from) + edit.insert + result.slice(edit.range.to)
  }
  return result
}

/** Narrows an accepted preview, failing loudly (red) on rejection. */
function editOf (preview: ReferenceRenamePreview, label: string): WorkspaceReferenceEdit {
  assert.equal(
    preview.status,
    'ok',
    `${label}: the preview must be accepted, got ${JSON.stringify(preview)}`
  )
  return (preview as Extract<ReferenceRenamePreview, { status: 'ok' }>).edit
}

/** One scratch workspace: fixture copy, provider, FSAL seam, live Halphen buffer. */
interface ScratchWorkspace {
  root: string
  provider: ReferenceProvider
  /** The real 'application'-channel command chain over this provider (B7) */
  command: RenameReference
  /**
   * The document authority's open buffer map behind the injected
   * readMarkdownBufferContent seam (issue #53): a path present here IS an
   * open markdown buffer with exactly this text.
   */
  authorityBuffers: Map<string, string>
  /** Fires every pending debounced authority extraction (injected scheduler). */
  fireScheduled: () => void
  paths: {
    theorems: string
    halphen: string
    coble: string
    otherPaper: string
    standalone: string
  }
  /** Original on-disk bytes at setup time, by absolute scratch path */
  originals: Map<string, string>
}

async function setUpScratchWorkspace (): Promise<ScratchWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'zettlr-reference-rename-'))
  await cp(FIXTURE_ROOT, root, { recursive: true })

  const paths = {
    theorems: path.join(root, 'ProjectA', 'Theorems.md'),
    halphen: path.join(root, 'ProjectA', 'Halphen_Surfaces.md'),
    coble: path.join(root, 'ProjectA', 'Coble_Lattice_Table.md'),
    otherPaper: path.join(root, 'ProjectB', 'Other_Paper.md'),
    standalone: path.join(root, 'Standalone_Notes.md')
  }

  const originals = new Map<string, string>()
  for (const relative of RELATIVE_FILES) {
    const absolute = path.join(root, relative)
    originals.set(absolute, readFileSync(absolute, 'utf-8'))
  }

  const seam = new EventEmitter()
  const authorityBuffers = new Map<string, string>()
  const scheduled: Array<{ callback: () => void, cancelled: boolean }> = []
  const provider = new ReferenceProvider(
    new LogProvider(),
    seam,
    {
      readMarkdownBufferContent: (filePath: string) => authorityBuffers.get(filePath),
      applyWorkspaceTextEdits: async (edits: WorkspaceTextEdit[]) => {
        const paths = [...new Set(edits.map(edit => edit.documentPath))]
        for (const documentPath of paths) {
          const content = authorityBuffers.get(documentPath)
          assert(content !== undefined, `Workspace edit names unopened authority buffer ${documentPath}`)
          authorityBuffers.set(
            documentPath,
            applyEdits(content, edits.filter(edit => edit.documentPath === documentPath))
          )
        }
        return paths
      }
    },
    500,
    {
      schedule: (callback: () => void, _delayMs: number) => {
        const task = { callback, cancelled: false }
        scheduled.push(task)
        return { cancel: () => { task.cancelled = true } }
      }
    }
  )
  const fireScheduled = (): void => {
    for (const task of scheduled.splice(0)) {
      if (!task.cancelled) {
        task.callback()
      }
    }
  }
  await provider.boot()
  for (const absolute of originals.keys()) {
    seam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(absolute) })
  }

  // The REAL command object CommandProvider dispatches 'application'-channel
  // rename events to, bound to this provider at the exact injection point
  // (this._app.references) — the renderer-reachable production route.
  const command = new RenameReference({ references: provider } as unknown as AppServiceContainer)

  // Halphen_Surfaces.md is OPEN in the document authority (content identical
  // to disk), and the authority reported the load (issue #53). The commit
  // must route Halphen through the authority, never through a disk write.
  authorityBuffers.set(paths.halphen, originals.get(paths.halphen) ?? '')
  provider.reportAuthorityBuffer(paths.halphen)
  fireScheduled()

  return { root, provider, command, authorityBuffers, fireScheduled, paths, originals }
}

/** Byte-compares every workspace file against the expected content map. */
function assertWorkspaceBytes (scratch: ScratchWorkspace, expected: Map<string, string>, label: string): void {
  for (const relative of RELATIVE_FILES) {
    const absolute = path.join(scratch.root, relative)
    assert.equal(
      readFileSync(absolute, 'utf-8'),
      expected.get(absolute),
      `${label}: ${relative} must match the expected bytes exactly`
    )
  }
}

describe('Workspace rename commit protocol', function () {
  describe('conflict abort', function () {
    let scratch: ScratchWorkspace

    before(async function () {
      scratch = await setUpScratchWorkspace()
    })

    after(async function () {
      await scratch.provider.shutdown()
      await rm(scratch.root, { recursive: true, force: true })
    })

    it('preview-reference-rename over the merged workspace computes the complete four-document edit', async function () {
      const preview = await scratch.command.run('preview-reference-rename', { oldKey: OLD_KEY, newKey: NEW_KEY }) as ReferenceRenamePreview
      const edit = editOf(preview, 'command preview-reference-rename')

      const touched = [...new Set(edit.edits.map(e => e.documentPath))].sort()
      assert.deepEqual(
        touched,
        [ scratch.paths.theorems, scratch.paths.otherPaper, scratch.paths.halphen, scratch.paths.standalone ].sort(),
        'both duplicate definitions plus the cluster and bare occurrences must be edited'
      )
      assert.deepEqual(
        edit.expectedSourceHashes,
        {
          [scratch.paths.theorems]: hashDocumentSource(scratch.originals.get(scratch.paths.theorems) ?? ''),
          [scratch.paths.otherPaper]: hashDocumentSource(scratch.originals.get(scratch.paths.otherPaper) ?? ''),
          [scratch.paths.halphen]: hashDocumentSource(scratch.originals.get(scratch.paths.halphen) ?? ''),
          [scratch.paths.standalone]: hashDocumentSource(scratch.originals.get(scratch.paths.standalone) ?? '')
        },
        'every touched document must be fenced at its current workspace content'
      )
    })

    it('commit-reference-rename aborts atomically with a structured conflict when a closed file changed on disk', async function () {
      const preview = await scratch.command.run('preview-reference-rename', { oldKey: OLD_KEY, newKey: NEW_KEY }) as ReferenceRenamePreview
      const edit = editOf(preview, 'conflict-path preview')

      // Concurrent interference: ONE closed file changes on disk after the
      // preview, with NO FSAL event — the provider's index still holds the
      // stale snapshot, so the commit must RE-READ THE DISK to notice.
      const mutated = (scratch.originals.get(scratch.paths.standalone) ?? '') + '\nAppended concurrent edit.\n'
      writeFileSync(scratch.paths.standalone, mutated, 'utf-8')

      const expectedBytes = new Map(scratch.originals)
      expectedBytes.set(scratch.paths.standalone, mutated)

      const outcome = await scratch.command.run('commit-reference-rename', { edit }) as CommitRenameOutcome
      assert.equal(
        outcome.status,
        'conflict',
        `a hash mismatch must abort the whole commit, got ${JSON.stringify(outcome)}`
      )
      assert.deepEqual(
        outcome.status === 'conflict' ? outcome.conflict : undefined,
        {
          status: 'conflict',
          documentPath: scratch.paths.standalone,
          expectedSourceHash: edit.expectedSourceHashes[scratch.paths.standalone],
          actualSourceHash: hashDocumentSource(mutated)
        },
        'the conflict must name the mismatching document and both hashes'
      )

      // ATOMICITY: nothing was applied anywhere. Every file keeps its exact
      // pre-commit bytes (including the concurrent mutation itself).
      assertWorkspaceBytes(scratch, expectedBytes, 'after conflicted commit')

      // No temp+rename debris either (issue #5, C9): the conflicted commit
      // leaves the workspace directories containing exactly the fixture
      // files — no staged .*.tmp artifact survives the abort.
      assert.deepEqual(readdirSync(path.join(scratch.root, 'ProjectA')).sort(), [ 'Coble_Lattice_Table.md', 'Halphen_Surfaces.md', 'Theorems.md' ])
      assert.deepEqual(readdirSync(path.join(scratch.root, 'ProjectB')), ['Other_Paper.md'])
      assert.deepEqual(readdirSync(scratch.root).sort(), [ 'ProjectA', 'ProjectB', 'Standalone_Notes.md' ])

      // The live overlay is untouched: Halphen still serves the authority's
      // load-time content, and no transaction reached any buffer.
      const state = await invoke('get-snapshot') as WorkspaceReferenceState
      const halphen = state.snapshots.find(s => s.documentPath === scratch.paths.halphen)
      assert.equal(
        halphen?.sourceHash,
        hashDocumentSource(scratch.originals.get(scratch.paths.halphen) ?? ''),
        'a conflicted commit must leave the open buffer overlay untouched'
      )
    })
  })

  describe('applied path and one-shot undo', function () {
    let scratch: ScratchWorkspace
    let previewedEdit: WorkspaceReferenceEdit|undefined
    let commitOutcome: CommitRenameOutcome|undefined

    before(async function () {
      scratch = await setUpScratchWorkspace()
    })

    after(async function () {
      await scratch.provider.shutdown()
      await rm(scratch.root, { recursive: true, force: true })
    })

    it('commit-reference-rename writes closed files atomically and acknowledges open authority buffers', async function () {
      const preview = await scratch.command.run('preview-reference-rename', { oldKey: OLD_KEY, newKey: NEW_KEY }) as ReferenceRenamePreview
      previewedEdit = editOf(preview, 'applied-path preview')

      const outcome = await scratch.command.run('commit-reference-rename', { edit: previewedEdit }) as CommitRenameOutcome
      assert.equal(outcome.status, 'applied', `the clean commit must apply, got ${JSON.stringify(outcome)}`)
      commitOutcome = outcome

      const closedPaths = [ scratch.paths.theorems, scratch.paths.otherPaper, scratch.paths.standalone ]
      assert.deepEqual(
        outcome.status === 'applied' ? [...outcome.closedFilesWritten].sort() : undefined,
        [...closedPaths].sort(),
        'exactly the closed documents are written on disk; the open Halphen buffer is never a disk write'
      )

      // Closed files: byte-assert the rewritten content against the
      // renderer/disk application oracle over the previewed edits.
      const expectedBytes = new Map(scratch.originals)
      for (const closedPath of closedPaths) {
        expectedBytes.set(closedPath, applyEdits(
          scratch.originals.get(closedPath) ?? '',
          previewedEdit.edits.filter(e => e.documentPath === closedPath)
        ))
      }
      // The OPEN buffer's disk file is untouched: it stays dirty in the
      // renderer until the user saves.
      assertWorkspaceBytes(scratch, expectedBytes, 'after applied commit')

      // The provider routes every open transaction through the central
      // document authority and reports the acknowledged paths.
      assert.deepEqual(
        outcome.status === 'applied' ? outcome.openBuffersUpdated : undefined,
        [scratch.paths.halphen],
        'the open Halphen authority buffer must be acknowledged before success'
      )
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        applyEdits(
          scratch.originals.get(scratch.paths.halphen) ?? '',
          previewedEdit.edits.filter(e => e.documentPath === scratch.paths.halphen)
        ),
        'the central authority owns the renamed open-buffer text'
      )

      // No temp+rename debris: the workspace directories contain exactly
      // the fixture files.
      assert.deepEqual(readdirSync(path.join(scratch.root, 'ProjectA')).sort(), [ 'Coble_Lattice_Table.md', 'Halphen_Surfaces.md', 'Theorems.md' ])
      assert.deepEqual(readdirSync(path.join(scratch.root, 'ProjectB')), ['Other_Paper.md'])
      assert.deepEqual(readdirSync(scratch.root).sort(), [ 'ProjectA', 'ProjectB', 'Standalone_Notes.md' ])

      scratch.provider.reportAuthorityBuffer(scratch.paths.halphen)
      scratch.fireScheduled()
    })

    it('undo-reference-rename is hash-fenced, restores every byte, and is one-shot', async function () {
      assert.ok(
        previewedEdit !== undefined && commitOutcome?.status === 'applied',
        'undo requires the applied commit from the previous spec'
      )

      const renamedTheorems = applyEdits(
        scratch.originals.get(scratch.paths.theorems) ?? '',
        previewedEdit.edits.filter(e => e.documentPath === scratch.paths.theorems)
      )

      // Hash fence: mutate one closed file AFTER the commit; the undo must
      // abort whole with a structured conflict and consume nothing.
      const interfered = renamedTheorems + '\nPost-commit interference.\n'
      writeFileSync(scratch.paths.theorems, interfered, 'utf-8')

      const conflicted = await scratch.command.run('undo-reference-rename', undefined) as UndoRenameOutcome
      assert.equal(
        conflicted.status,
        'conflict',
        `an interfered undo must abort, got ${JSON.stringify(conflicted)}`
      )
      assert.deepEqual(
        conflicted.status === 'conflict' ? conflicted.conflict : undefined,
        {
          status: 'conflict',
          documentPath: scratch.paths.theorems,
          expectedSourceHash: hashDocumentSource(renamedTheorems),
          actualSourceHash: hashDocumentSource(interfered)
        },
        'the undo fence must compare against the post-commit content'
      )

      // The conflicted undo leaves no temp+rename debris behind (issue #5,
      // C9): the workspace directories still contain exactly the fixture
      // files.
      assert.deepEqual(readdirSync(path.join(scratch.root, 'ProjectA')).sort(), [ 'Coble_Lattice_Table.md', 'Halphen_Surfaces.md', 'Theorems.md' ])
      assert.deepEqual(readdirSync(path.join(scratch.root, 'ProjectB')), ['Other_Paper.md'])
      assert.deepEqual(readdirSync(scratch.root).sort(), [ 'ProjectA', 'ProjectB', 'Standalone_Notes.md' ])

      // The interference is withdrawn (the concurrent editor restores the
      // post-commit bytes); the pending undo record must have survived the
      // conflicted attempt.
      writeFileSync(scratch.paths.theorems, renamedTheorems, 'utf-8')

      const applied = await scratch.command.run('undo-reference-rename', undefined) as UndoRenameOutcome
      assert.equal(applied.status, 'applied', `the clean undo must apply, got ${JSON.stringify(applied)}`)
      assert.deepEqual(
        applied.status === 'applied' ? [...applied.closedFilesWritten].sort() : undefined,
        [ scratch.paths.theorems, scratch.paths.otherPaper, scratch.paths.standalone ].sort(),
        'the undo rewrites exactly the closed files'
      )

      // Closed files return to their ORIGINAL fixture bytes; the open
      // Halphen buffer's disk file remains untouched throughout.
      assertWorkspaceBytes(scratch, scratch.originals, 'after applied undo')

      assert.deepEqual(
        applied.status === 'applied' ? applied.openBuffersUpdated : undefined,
        [scratch.paths.halphen],
        'the open Halphen undo must be acknowledged before undo reports success'
      )
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        scratch.originals.get(scratch.paths.halphen),
        'the inverse authority transaction must restore the open buffer byte-exactly'
      )
      scratch.provider.reportAuthorityBuffer(scratch.paths.halphen)
      scratch.fireScheduled()

      // One-shot: the applied undo consumed the record.
      const exhausted = await scratch.command.run('undo-reference-rename', undefined) as UndoRenameOutcome
      assert.deepEqual(
        exhausted,
        { status: 'no-pending-undo' },
        'a second undo has nothing left to restore'
      )
    })
  })
})
