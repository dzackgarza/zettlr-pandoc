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
 *                  (./reference-index.ts) for issue #1 Phase 3b, reworked
 *                  for issue #53: the live side of the merged view is
 *                  derived in MAIN from the document authority — the
 *                  renderer never reports document-derived state.
 *
 *                  CONTRACT (locked by test/reference-provider-shell.spec.ts):
 *
 *                  - The constructor follows the LinkProvider pattern
 *                    (../links/index.ts): it receives its LogProvider, FSAL,
 *                    and document-authority dependencies by injection and
 *                    registers exactly one ipcMain.handle('reference-provider',
 *                    …) handler serving exactly one command:
 *
 *                      'get-snapshot' -> index.getSnapshot()
 *
 *                    A command outside that map THROWS (issue #5, B20):
 *                    the channel never answers an unknown command with a
 *                    silent undefined. The former renderer report channel
 *                    ('report-live-buffer'/'drop-live-buffer') is gone by
 *                    design (issue #53) and therefore throws.
 *
 *                  - The DOCUMENT AUTHORITY (the documents provider) drives
 *                    the live side: it calls reportAuthorityBuffer() when it
 *                    loads or mutates a markdown buffer and
 *                    dropAuthorityBuffer() when it closes one. Reports are
 *                    debounced per document through the injected scheduler;
 *                    when a debounce fires, the provider reads the CURRENT
 *                    buffer text through the injected authority seam and
 *                    runs the shared extractor over it in main. Ordering is
 *                    the authority's own call order — monotonic across
 *                    windows by construction, so no generation counters
 *                    exist anywhere.
 *
 *                    The rename protocol (previewRename/commitRename/
 *                    undoRename) is NOT part of this channel (review B7):
 *                    production reaches it exclusively through the
 *                    'application' channel's RenameReference command
 *                    (commands/rename-reference.ts), which calls the
 *                    provider methods directly. That chain is locked by
 *                    test/reference-rename-atomicity.spec.ts and
 *                    test/reference-rename-undo-route.spec.ts.
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
 *                  - shutdown() unsubscribes the FSAL event listener and
 *                    cancels every pending debounced report.
 *
 * END HEADER
 */

import { ipcMain } from 'electron'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import type { FSALEventPayload } from '../fsal'
import type { WorkspaceReferenceEdit, WorkspaceTextEdit } from '@dts/common/references'
import { extractReferences } from '@common/pandoc-util/extract-references'
import {
  previewReferenceRename,
  type CommitRenameOutcome,
  type ReferenceRenamePreview,
  type UndoRenameOutcome
} from '@common/pandoc-util/compute-reference-edits'
import { ReferenceIndex, type WorkspaceReferenceState } from './reference-index'
import {
  recoverWorkspaceEditJournal,
  runWorkspaceEditTransaction,
  type WorkspaceEditAuthority
} from './workspace-edit-transaction'

/**
 * The one-shot pending workspace undo recorded by an applied commitRename().
 */
interface PendingUndo {
  /** The inverse edits, expressed in post-commit coordinates */
  edits: WorkspaceTextEdit[]
  /** Every fenced documentPath, in the committed edit's fence order */
  documentPaths: string[]
  /**
   * Expected post-commit sourceHash per documentPath. Closed files fence on
   * the just-written disk content; open buffers fence on the post-commit
   * content acknowledged by the authority after it applies the committed
   * edits (issue #53), so a user edit between commit and undo changes the
   * hash and surfaces as a conflict.
   */
  expectedSourceHashes: Record<string, string>
}

/**
 * The wire contract of the 'reference-provider' ipc channel. The provider is
 * the single owner of this type; the renderer bridge imports it so a wrong
 * command or payload fails to compile at the call site.
 */
export type ReferenceProviderIPCAPI = { command: 'get-snapshot', payload?: undefined }

/**
 * The slice of the document authority (the documents provider) this provider
 * reads live buffers through (issue #53). The authority owns every open
 * buffer's text; this seam returns the CURRENT text of an open markdown
 * document, or undefined when the path is not an open markdown buffer.
 */
export type ReferenceDocumentAuthority = WorkspaceEditAuthority

/**
 * The slice of FSAL this provider actually consumes: the 'fsal-event'
 * subscription surface. The real FSAL satisfies it directly, and specs
 * inject a plain EventEmitter — no type escapes anywhere.
 */
export interface ReferenceFSALEvents {
  on: (evt: 'fsal-event', callback: (event: FSALEventPayload) => void) => void
  off: (evt: 'fsal-event', callback: (event: FSALEventPayload) => void) => void
}

/** A scheduled deferred extraction that can be cancelled before it fires. */
export interface AuthorityReportTask {
  cancel: () => void
}

/**
 * The injected deferred-execution seam. Production backs this with
 * setTimeout/clearTimeout; specs fire the recorded callbacks manually so the
 * debounce is proven headlessly without wall-clock waits.
 */
export interface AuthorityReportScheduler {
  schedule: (callback: () => void, delayMs: number) => AuthorityReportTask
}

/** The production scheduler: plain setTimeout/clearTimeout. */
const setTimeoutScheduler: AuthorityReportScheduler = {
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    return { cancel: () => { clearTimeout(handle) } }
  }
}

/**
 * Serves the merged workspace reference view (saved FSAL snapshots overlaid
 * by authority-derived live buffers) to every consumer over the
 * 'reference-provider' ipc channel.
 */
export default class ReferenceProvider extends ProviderContract {
  private readonly _index: ReferenceIndex
  /** The one-shot pending workspace undo, if the last commit applied */
  private _pendingUndo: PendingUndo|undefined
  /** Pending debounced extractions by documentPath */
  private readonly _pendingReports: Map<string, AuthorityReportTask>

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
    private readonly _fsal: ReferenceFSALEvents,
    private readonly _authority: ReferenceDocumentAuthority,
    private readonly _authorityReportDebounceMs: number,
    /** Application data directory holding the workspace-edit journal */
    private readonly _journalDirectory: string,
    private readonly _scheduler: AuthorityReportScheduler = setTimeoutScheduler
  ) {
    super()
    this._index = new ReferenceIndex()
    this._pendingReports = new Map()

    ipcMain.handle('reference-provider', (_event, message: ReferenceProviderIPCAPI) => {
      const { command } = message

      if (command === 'get-snapshot') {
        return this._index.getSnapshot()
      }

      // Fail loud (issue #5, B20): a command outside the delegation map is
      // a caller bug, never a silently-undefined response. The renderer
      // report channel of the pre-#53 architecture lands here by design.
      throw new Error(`reference-provider: unknown command ${String(command)}`)
    })
  }

  /**
   * The document authority loaded or mutated a markdown buffer: schedule
   * (or reschedule) one extraction of that buffer. Edits debounce (typing
   * storms coalesce); a LOAD is a single event and extracts immediately
   * (issue #46: the merged view must serve a just-opened document's
   * occurrences before the user can click its citing badge). When the task
   * fires, the CURRENT authority text is extracted — a buffer closed in
   * the meantime resolves to a drop, so the overlay is always a function
   * of the authority's open set and text.
   *
   * @param   {string}   filePath   The changed document's path
   * @param   {boolean}  immediate  True for single events (load/move)
   */
  public reportAuthorityBuffer (filePath: string, immediate: boolean = false): void {
    this._pendingReports.get(filePath)?.cancel()
    this._pendingReports.set(filePath, this._scheduler.schedule(() => {
      this._pendingReports.delete(filePath)

      const content = this._authority.readMarkdownBufferContent(filePath)
      if (content === undefined) {
        // The buffer closed between the change and the debounce firing:
        // the overlay follows the authority's open set.
        if (this._index.dropLiveBuffer(filePath)) {
          broadcastIpcMessage('references')
        }
        return
      }

      this._index.reportLiveBuffer(extractReferences(filePath, content))
      broadcastIpcMessage('references')
    }, immediate ? 0 : this._authorityReportDebounceMs))
  }

  /**
   * The document authority closed a buffer: cancel any pending extraction
   * and drop its overlay immediately, reverting the document to its saved
   * FSAL snapshot.
   *
   * @param   {string}  filePath  The closed document's path
   */
  public dropAuthorityBuffer (filePath: string): void {
    this._pendingReports.get(filePath)?.cancel()
    this._pendingReports.delete(filePath)
    if (this._index.dropLiveBuffer(filePath)) {
      broadcastIpcMessage('references')
    }
  }

  /**
   * Subscribes to the injected FSAL's 'fsal-event' stream so saved snapshots
   * follow the on-disk workspace state, and finishes any workspace-edit
   * transaction a crash interrupted before the app reads a half-written
   * workspace.
   */
  public async boot (): Promise<void> {
    this._fsal.on('fsal-event', this._onFsalEvent)
    const restored = await recoverWorkspaceEditJournal(this._journalDirectory)
    if (restored.length > 0) {
      this._logger.warning(
        `[Reference Provider] Restored ${restored.length} file(s) from an interrupted workspace edit`,
        restored
      )
    }
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
   * The journaled workspace-edit transaction owns the whole sequence: it
   * re-verifies EVERY document named in edit.expectedSourceHashes against
   * current reality before touching anything (open buffers through the
   * document authority, closed files re-read from disk), aborts the ENTIRE
   * operation on any mismatch, and rolls every buffer and file back if a
   * later step fails. This method only records the one-shot inverse as the
   * pending workspace undo, fenced on the transaction's resulting hashes.
   *
   * @param   {WorkspaceReferenceEdit}        edit  The previewed edit to apply
   *
   * @return  {Promise<CommitRenameOutcome>}        The typed commit outcome
   */
  public async commitRename (edit: WorkspaceReferenceEdit): Promise<CommitRenameOutcome> {
    const result = await runWorkspaceEditTransaction(this._authority, this._journalDirectory, {
      edits: edit.edits,
      expectedSourceHashes: edit.expectedSourceHashes
    })

    if (result.status === 'conflict') {
      return {
        status: 'conflict',
        conflict: {
          status: 'conflict',
          documentPath: result.documentPath,
          expectedSourceHash: result.expectedSourceHash,
          actualSourceHash: result.actualSourceHash
        }
      }
    }

    this._pendingUndo = {
      edits: edit.undo,
      documentPaths: Object.keys(edit.expectedSourceHashes),
      expectedSourceHashes: result.resultingHashes
    }

    broadcastIpcMessage('references')

    return {
      status: 'applied',
      closedFilesWritten: result.closedFilesWritten,
      openBuffersUpdated: result.openBuffersUpdated
    }
  }

  /**
   * Applies the pending one-shot workspace undo recorded by the last applied
   * commitRename(), through the same journaled transaction the commit used.
   *
   * The undo is hash-fenced exactly like the commit — against the post-commit
   * content of every touched document — and ANY mismatch aborts the whole
   * undo with a structured conflict, leaving the pending undo record intact
   * for a retry. An applied undo CONSUMES the record: a subsequent
   * undoRename() reports 'no-pending-undo'.
   *
   * @return  {Promise<UndoRenameOutcome>}  The typed undo outcome
   */
  public async undoRename (): Promise<UndoRenameOutcome> {
    const pending = this._pendingUndo
    if (pending === undefined) {
      return { status: 'no-pending-undo' }
    }

    const result = await runWorkspaceEditTransaction(this._authority, this._journalDirectory, {
      edits: pending.edits,
      expectedSourceHashes: pending.expectedSourceHashes
    })

    if (result.status === 'conflict') {
      return {
        status: 'conflict',
        conflict: {
          status: 'conflict',
          documentPath: result.documentPath,
          expectedSourceHash: result.expectedSourceHash,
          actualSourceHash: result.actualSourceHash
        }
      }
    }

    // One-shot: the applied undo consumes the record.
    this._pendingUndo = undefined

    broadcastIpcMessage('references')

    return {
      status: 'applied',
      closedFilesWritten: result.closedFilesWritten,
      openBuffersUpdated: result.openBuffersUpdated
    }
  }

  /**
   * Shuts down the service provider, unsubscribing from FSAL events and
   * cancelling every pending debounced report.
   */
  public async shutdown (): Promise<void> {
    this._fsal.off('fsal-event', this._onFsalEvent)
    for (const task of this._pendingReports.values()) {
      task.cancel()
    }
    this._pendingReports.clear()
    this._logger.verbose('Reference provider shutting down ...')
  }
}

