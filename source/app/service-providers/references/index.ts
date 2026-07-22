/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceProvider class
 * CVM-Role:        Service Provider
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Electron shell around the pure ReferenceIndex
 *                  (./reference-index.ts) for issue #1 Phase 3b.
 *
 *                  CONTRACT (locked by test/reference-provider-shell.spec.ts):
 *
 *                  - The constructor follows the LinkProvider pattern
 *                    (../links/index.ts): it receives its LogProvider and
 *                    FSAL dependencies by injection and registers exactly one
 *                    ipcMain.handle('reference-provider', …) handler whose
 *                    commands delegate 1:1 to the ReferenceIndex per that
 *                    class's own delegation map:
 *
 *                      'get-snapshot'       -> index.getSnapshot()
 *                      'report-live-buffer' -> index.reportLiveBuffer(
 *                                                payload.snapshot,
 *                                                payload.generation)
 *                      'drop-live-buffer'   -> index.dropLiveBuffer(
 *                                                payload.documentPath)
 *                      'preview-rename'     -> this.previewRename(
 *                                                payload.oldKey,
 *                                                payload.newKey)
 *                      'commit-rename'      -> this.commitRename(payload.edit)
 *                      'undo-rename'        -> this.undoRename()
 *
 *                  - boot() subscribes to the injected FSAL's 'fsal-event':
 *                    'add'/'change' events carrying a markdown file
 *                    descriptor apply that descriptor's FSAL-owned saved
 *                    snapshot (descriptor.references) via
 *                    index.applySavedSnapshot(); 'unlink' events remove the
 *                    saved snapshot via index.removeSavedSnapshot(path).
 *                    After every state transition the provider broadcasts
 *                    'references' to all windows (broadcastIpcMessage), which
 *                    MainEditor.vue already consumes to refresh the combined
 *                    @-completion database.
 *
 *                  - getSnapshot() exposes the same merged
 *                    WorkspaceReferenceState the ipc handler serves, for
 *                    main-process consumers.
 *
 *                  - shutdown() unsubscribes the FSAL event listener.
 *
 * END HEADER
 */

import { ipcMain } from 'electron'
import { randomBytes } from 'crypto'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import path from 'path'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import type FSAL from '../fsal'
import type { FSALEventPayload } from '../fsal'
import type { DocumentReferenceSnapshot, WorkspaceReferenceEdit, WorkspaceTextEdit } from '@dts/common/references'
import { hashDocumentSource } from '@common/pandoc-util/extract-references'
import {
  previewReferenceRename,
  type CommitRenameOutcome,
  type ReferenceRenamePreview,
  type UndoRenameOutcome
} from '@common/pandoc-util/compute-reference-edits'
import { ReferenceIndex, type WorkspaceReferenceState } from './reference-index'

/**
 * Applies a document's WorkspaceTextEdits to its source, descending by range
 * start so earlier ranges stay valid — the same application contract the
 * renderer uses for open-buffer transactions.
 *
 * @param   {string}               source  The document source
 * @param   {WorkspaceTextEdit[]}  edits   The edits to apply
 *
 * @return  {string}                       The rewritten source
 */
function applyTextEdits (source: string, edits: WorkspaceTextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.range.from - a.range.from)
  let result = source
  for (const edit of ordered) {
    result = result.slice(0, edit.range.from) + edit.insert + result.slice(edit.range.to)
  }
  return result
}

/**
 * The one-shot pending workspace undo recorded by an applied commitRename().
 */
interface PendingUndo {
  /** The inverse edits, expressed in post-commit coordinates */
  edits: WorkspaceTextEdit[]
  /** Every fenced documentPath, in the committed edit's fence order */
  documentPaths: string[]
  /** Expected post-commit sourceHash per documentPath */
  expectedSourceHashes: Record<string, string>
  /**
   * Open-buffer documents whose post-commit hash is not knowable at commit
   * time (the provider never holds buffer text): the renderer applies the
   * returned transactions and re-reports its live snapshot, and that first
   * post-commit report establishes the undo fence for the document.
   */
  awaitingLiveReport: Set<string>
}

/**
 * Serves the merged workspace reference view (saved FSAL snapshots overlaid
 * by renderer-reported live buffers) to every consumer over the
 * 'reference-provider' ipc channel.
 */
export default class ReferenceProvider extends ProviderContract {
  private readonly _index: ReferenceIndex
  /** The one-shot pending workspace undo, if the last commit applied */
  private _pendingUndo: PendingUndo|undefined

  /**
   * Applies FSAL state transitions to the index: 'add'/'change' events
   * carrying a markdown file descriptor apply its FSAL-owned saved snapshot,
   * 'unlink' events remove the document's saved snapshot. Every applied
   * transition is announced with a 'references' broadcast.
   */
  private readonly _onFsalEvent = (payload: FSALEventPayload): void => {
    if (payload.event === 'unlink') {
      this._index.removeSavedSnapshot(payload.path)
      broadcastIpcMessage('references')
    } else if ((payload.event === 'add' || payload.event === 'change') && payload.descriptor.type === 'file') {
      this._index.applySavedSnapshot(payload.descriptor.references)
      broadcastIpcMessage('references')
    }
  }

  constructor (
    private readonly _logger: LogProvider,
    private readonly _fsal: FSAL
  ) {
    super()
    this._index = new ReferenceIndex()

    ipcMain.handle('reference-provider', (_event, message: { command: string, payload?: unknown }) => {
      const { command } = message

      if (command === 'get-snapshot') {
        return this._index.getSnapshot()
      } else if (command === 'report-live-buffer') {
        const { snapshot, generation } = message.payload as { snapshot: DocumentReferenceSnapshot, generation: number }
        this._index.reportLiveBuffer(snapshot, generation)

        // A pending undo may be waiting for this buffer's post-commit
        // content: the first accepted report after the commit establishes
        // the document's undo fence.
        const pending = this._pendingUndo
        if (pending !== undefined && pending.awaitingLiveReport.has(snapshot.documentPath)) {
          const acceptedHash = this._index.liveBufferSourceHash(snapshot.documentPath)
          if (acceptedHash !== undefined) {
            pending.expectedSourceHashes[snapshot.documentPath] = acceptedHash
            pending.awaitingLiveReport.delete(snapshot.documentPath)
          }
        }

        broadcastIpcMessage('references')
      } else if (command === 'drop-live-buffer') {
        const { documentPath } = message.payload as { documentPath: string }
        this._index.dropLiveBuffer(documentPath)
        broadcastIpcMessage('references')
      } else if (command === 'preview-rename') {
        const { oldKey, newKey } = message.payload as { oldKey: string, newKey: string }
        return this.previewRename(oldKey, newKey)
      } else if (command === 'commit-rename') {
        const { edit } = message.payload as { edit: WorkspaceReferenceEdit }
        return this.commitRename(edit)
      } else if (command === 'undo-rename') {
        return this.undoRename()
      }
    })
  }

  /**
   * Subscribes to the injected FSAL's 'fsal-event' stream so saved snapshots
   * follow the on-disk workspace state.
   */
  public async boot (): Promise<void> {
    this._fsal.on('fsal-event', this._onFsalEvent)
  }

  /**
   * Returns the merged workspace reference state — the same state the ipc
   * surface serves.
   *
   * @return  {WorkspaceReferenceState}  The merged workspace reference state
   */
  public getSnapshot (): WorkspaceReferenceState {
    return this._index.getSnapshot()
  }

  /**
   * Previews the workspace rename of oldKey to newKey over the CURRENT
   * merged workspace state (live overlays already substituted), delegating
   * to the pure previewReferenceRename(). The preview never partitions
   * open-buffer vs closed-file documents and never touches disk.
   *
   * @param   {string}                  oldKey  The full key being renamed
   * @param   {string}                  newKey  The full replacement key
   *
   * @return  {ReferenceRenamePreview}          The previewed edit or a typed rejection
   */
  public previewRename (oldKey: string, newKey: string): ReferenceRenamePreview {
    return previewReferenceRename(this._index.getSnapshot().snapshots, oldKey, newKey)
  }

  /**
   * Commits a previewed workspace rename atomically.
   *
   * CONTRACT (locked red by test/reference-rename-atomicity.spec.ts):
   *
   * - Re-verifies EVERY document named in edit.expectedSourceHashes against
   *   current reality BEFORE applying anything: documents with a live
   *   overlay are checked against the overlay's current sourceHash; all
   *   other documents are RE-READ FROM DISK and re-hashed (a stale index
   *   snapshot is not trusted). ANY mismatch aborts the ENTIRE operation
   *   with a structured conflict naming the first mismatching document —
   *   nothing is applied anywhere, no file and no buffer.
   * - On success, partitions the edits by the live-overlay map: closed
   *   files are rewritten atomically (write to a temp file in the same
   *   directory, then rename over the original); open-buffer edits are
   *   RETURNED as openBufferTransactions for the RENDERER to apply as
   *   CodeMirror transactions, leaving those buffers dirty/unsaved (the
   *   main process cannot reach live CodeMirror buffers).
   * - Records a one-shot inverse WorkspaceReferenceEdit as the pending
   *   workspace undo consumed by undoRename().
   *
   * @param   {WorkspaceReferenceEdit}        edit  The previewed edit to apply
   *
   * @return  {Promise<CommitRenameOutcome>}        The typed commit outcome
   */
  public async commitRename (edit: WorkspaceReferenceEdit): Promise<CommitRenameOutcome> {
    const documentPaths = Object.keys(edit.expectedSourceHashes)

    // Phase 1 — verify EVERY fenced document against current reality before
    // touching anything. Open buffers are checked through the live overlay;
    // everything else is re-read from disk and re-hashed (the index's saved
    // snapshot is never trusted here: a concurrent write without an FSAL
    // event must still be caught).
    const openBufferPaths: string[] = []
    const closedContents = new Map<string, string>()
    for (const documentPath of documentPaths) {
      const expected = edit.expectedSourceHashes[documentPath]
      const liveHash = this._index.liveBufferSourceHash(documentPath)
      let actual: string
      if (liveHash !== undefined) {
        openBufferPaths.push(documentPath)
        actual = liveHash
      } else {
        const content = await readFile(documentPath, 'utf-8')
        closedContents.set(documentPath, content)
        actual = hashDocumentSource(content)
      }

      if (actual !== expected) {
        // ANY mismatch aborts the ENTIRE commit: nothing has been applied
        // anywhere at this point, and no temp file exists yet.
        return {
          status: 'conflict',
          conflict: { status: 'conflict', documentPath, expectedSourceHash: expected, actualSourceHash: actual }
        }
      }
    }

    // Phase 2 — apply. Closed files are rewritten atomically on disk;
    // open-buffer edits are returned for the renderer to apply as
    // CodeMirror transactions (the main process cannot reach live buffers).
    const closedFilePaths = documentPaths.filter(p => !openBufferPaths.includes(p))
    const rewritten = new Map<string, string>()
    for (const documentPath of closedFilePaths) {
      const content = closedContents.get(documentPath)
      if (content === undefined) {
        throw new Error(`commit-rename: no verified disk content for ${documentPath}`)
      }
      rewritten.set(documentPath, applyTextEdits(content, edit.edits.filter(e => e.documentPath === documentPath)))
    }
    await this._writeFilesAtomically(rewritten)

    // Phase 3 — record the one-shot inverse as the pending workspace undo.
    // Closed files fence against the just-written content; open buffers
    // fence against the renderer's post-commit live report.
    const undoHashes: Record<string, string> = {}
    for (const documentPath of closedFilePaths) {
      undoHashes[documentPath] = hashDocumentSource(rewritten.get(documentPath) ?? '')
    }
    this._pendingUndo = {
      edits: edit.undo,
      documentPaths,
      expectedSourceHashes: undoHashes,
      awaitingLiveReport: new Set(openBufferPaths)
    }

    broadcastIpcMessage('references')

    return {
      status: 'applied',
      closedFilesWritten: closedFilePaths,
      openBufferTransactions: edit.edits.filter(e => openBufferPaths.includes(e.documentPath))
    }
  }

  /**
   * Rewrites every file in the map atomically: each new content is written
   * to a temp file in the file's own directory, and only after every temp
   * write succeeded are the temps renamed over their originals. A failed
   * temp write removes all staged temps and rethrows, leaving every
   * original byte-identical and no debris behind.
   *
   * @param   {Map<string, string>}  contents  New content per file path
   */
  private async _writeFilesAtomically (contents: Map<string, string>): Promise<void> {
    const tempPaths = new Map<string, string>()
    try {
      for (const [ filePath, content ] of contents) {
        const tempPath = path.join(
          path.dirname(filePath),
          `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`
        )
        await writeFile(tempPath, content, 'utf-8')
        tempPaths.set(filePath, tempPath)
      }
    } catch (err) {
      for (const tempPath of tempPaths.values()) {
        await unlink(tempPath).catch(() => { /* the temp never made it to disk */ })
      }
      throw err
    }

    for (const [ filePath, tempPath ] of tempPaths) {
      await rename(tempPath, filePath)
    }
  }

  /**
   * Applies the pending one-shot workspace undo recorded by the last
   * applied commitRename().
   *
   * CONTRACT (locked red by test/reference-rename-atomicity.spec.ts): the
   * undo is hash-fenced exactly like the commit — closed files are re-read
   * from disk and re-hashed against the post-commit content, open buffers
   * are checked through the live overlay — and ANY mismatch aborts the
   * whole undo with a structured conflict, leaving the pending undo record
   * intact. An applied undo restores every touched document (closed files
   * via atomic temp+rename writes, open buffers via returned
   * openBufferTransactions the renderer applies) and CONSUMES the record:
   * a subsequent undoRename() reports 'no-pending-undo'.
   *
   * @return  {Promise<UndoRenameOutcome>}  The typed undo outcome
   */
  public async undoRename (): Promise<UndoRenameOutcome> {
    const pending = this._pendingUndo
    if (pending === undefined) {
      return { status: 'no-pending-undo' }
    }

    // Verify every fenced document against current reality, partitioned by
    // the CURRENT live-overlay map (a buffer closed since the commit is a
    // closed file now). Any mismatch aborts the whole undo and leaves the
    // pending record intact for a retry once the interference is resolved.
    const openBufferPaths: string[] = []
    const closedContents = new Map<string, string>()
    for (const documentPath of pending.documentPaths) {
      if (pending.awaitingLiveReport.has(documentPath)) {
        // The renderer never reported the post-commit buffer, so no fence
        // exists: undoing now could corrupt the buffer. This is a protocol
        // violation, not a user-facing conflict — fail loudly.
        throw new Error(`undo-rename: no post-commit live report received for open buffer ${documentPath}`)
      }

      const expected = pending.expectedSourceHashes[documentPath]
      const liveHash = this._index.liveBufferSourceHash(documentPath)
      let actual: string
      if (liveHash !== undefined) {
        openBufferPaths.push(documentPath)
        actual = liveHash
      } else {
        const content = await readFile(documentPath, 'utf-8')
        closedContents.set(documentPath, content)
        actual = hashDocumentSource(content)
      }

      if (actual !== expected) {
        return {
          status: 'conflict',
          conflict: { status: 'conflict', documentPath, expectedSourceHash: expected, actualSourceHash: actual }
        }
      }
    }

    // Apply: closed files via atomic temp+rename writes, open buffers via
    // returned transactions the renderer applies.
    const closedFilePaths = pending.documentPaths.filter(p => !openBufferPaths.includes(p))
    const restored = new Map<string, string>()
    for (const documentPath of closedFilePaths) {
      const content = closedContents.get(documentPath)
      if (content === undefined) {
        throw new Error(`undo-rename: no verified disk content for ${documentPath}`)
      }
      restored.set(documentPath, applyTextEdits(content, pending.edits.filter(e => e.documentPath === documentPath)))
    }
    await this._writeFilesAtomically(restored)

    // One-shot: the applied undo consumes the record.
    this._pendingUndo = undefined

    broadcastIpcMessage('references')

    return {
      status: 'applied',
      closedFilesWritten: closedFilePaths,
      openBufferTransactions: pending.edits.filter(e => openBufferPaths.includes(e.documentPath))
    }
  }

  /**
   * Shuts down the service provider, unsubscribing from FSAL events.
   */
  public async shutdown (): Promise<void> {
    this._fsal.off('fsal-event', this._onFsalEvent)
    this._logger.verbose('Reference provider shutting down ...')
  }
}
