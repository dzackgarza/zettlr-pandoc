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
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import type FSAL from '../fsal'
import type { FSALEventPayload } from '../fsal'
import type { DocumentReferenceSnapshot, WorkspaceReferenceEdit } from '@dts/common/references'
import {
  previewReferenceRename,
  type CommitRenameOutcome,
  type ReferenceRenamePreview,
  type UndoRenameOutcome
} from '@common/pandoc-util/compute-reference-edits'
import { ReferenceIndex, type WorkspaceReferenceState } from './reference-index'

/**
 * Serves the merged workspace reference view (saved FSAL snapshots overlaid
 * by renderer-reported live buffers) to every consumer over the
 * 'reference-provider' ipc channel.
 */
export default class ReferenceProvider extends ProviderContract {
  private readonly _index: ReferenceIndex

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
   * PHASE 6 INERT SKELETON: verifies nothing, writes nothing, records no
   * undo, and reports the empty applied set. Every contract clause above is
   * locked red by the atomicity spec.
   *
   * @param   {WorkspaceReferenceEdit}        _edit  The previewed edit to apply
   *
   * @return  {Promise<CommitRenameOutcome>}         The typed commit outcome
   */
  public async commitRename (_edit: WorkspaceReferenceEdit): Promise<CommitRenameOutcome> {
    return { status: 'applied', closedFilesWritten: [], openBufferTransactions: [] }
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
   * PHASE 6 INERT SKELETON: no commit ever records an undo, so this
   * truthfully reports that nothing is pending.
   *
   * @return  {Promise<UndoRenameOutcome>}  The typed undo outcome
   */
  public async undoRename (): Promise<UndoRenameOutcome> {
    return { status: 'no-pending-undo' }
  }

  /**
   * Shuts down the service provider, unsubscribing from FSAL events.
   */
  public async shutdown (): Promise<void> {
    this._fsal.off('fsal-event', this._onFsalEvent)
    this._logger.verbose('Reference provider shutting down ...')
  }
}
