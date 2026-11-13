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
 *                    runs reference extraction in main. When Pandoc read
 *                    every citation of the text before, the snapshot has
 *                    its citations at once and one broadcast announces it.
 *                    Else Pandoc enriches the snapshot asynchronously;
 *                    request identity and source hash fence publication
 *                    against edits and document closure.
 *
 *                    The rename protocol (previewRename/commitRename/
 *                    undoRename) is NOT part of this channel (review B7):
 *                    production reaches it exclusively through the
 *                    'application' channel's RenameReference command
 *                    (commands/rename-reference.ts), which calls the
 *                    provider methods directly. That chain is locked by
 *                    test/reference-rename-atomicity.spec.ts and
 *                    test/reference-rename-authority.spec.ts.
 *
 *                  - boot() subscribes to the injected FSAL's 'fsal-events':
 *                    'add'/'change' events carrying a markdown file
 *                    descriptor apply that descriptor's FSAL-owned saved
 *                    snapshot (descriptor.references) via
 *                    index.applySavedSnapshot(); 'unlink' events remove the
 *                    saved snapshot via index.removeSavedSnapshot(path).
 *                    A batch of events that changed the merged view causes
 *                    one 'references' broadcast to all windows
 *                    (broadcastIpcMessage), which MainEditor.vue consumes to
 *                    refresh the combined @-completion database. A batch
 *                    that left the merged view as it was (a save below a
 *                    live buffer, a file that is not Markdown) causes none.
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

import { trans } from "@common/i18n-main";
import {
  type CommitRenameOutcome,
  previewReferenceRename,
  type ReferenceRenamePreview,
  type UndoRenameOutcome,
} from "@common/pandoc-util/compute-reference-edits";
import { extractReferences, hashDocumentSource } from "@common/pandoc-util/extract-references";
import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import { editedText, previewOf } from "@common/util/workspace-edit-preview";
import type { WorkspaceReferenceEdit, WorkspaceTextEdit } from "@dts/common/references";
import type LogProvider from "@providers/log";
import { ipcMain } from "electron";
import { readFile } from "fs/promises";
import type { FSALEventPayload } from "../fsal";
import ProviderContract, { type IPCMessage } from "../provider-contract";
import { extractPandocCitations, knownPandocCitations } from "./pandoc-citations";
import { ReferenceIndex, type WorkspaceReferenceState } from "./reference-index";
import {
  type JournalRecoveryAuthority,
  recoverWorkspaceEditJournal,
  runWorkspaceEditTransaction,
  type WorkspaceEditAuthority,
} from "./workspace-edit-transaction";

/**
 * The one-shot pending workspace undo recorded by an applied commitRename().
 */
interface PendingUndo {
  /** The inverse edits, expressed in post-commit coordinates */
  edits: WorkspaceTextEdit[];
  /** Every fenced documentPath, in the committed edit's fence order */
  documentPaths: string[];
  /**
   * Expected post-commit sourceHash per documentPath. Closed files fence on
   * the just-written disk content; open buffers fence on the post-commit
   * content acknowledged by the authority after it applies the committed
   * edits (issue #53), so a user edit between commit and undo changes the
   * hash and surfaces as a conflict.
   */
  expectedSourceHashes: Record<string, string>;
}

/**
 * The wire contract of the 'reference-provider' ipc channel. The provider is
 * the single owner of this type; the renderer bridge imports it so a wrong
 * command or payload fails to compile at the call site.
 */
export type ReferenceProviderIPCContract = {
  "get-snapshot": {
    request: { payload?: undefined };
    response: WorkspaceReferenceState;
  };
};

export type ReferenceProviderIPCAPI = IPCMessage<ReferenceProviderIPCContract>;

/**
 * The slice of the document authority (the documents provider) this provider
 * reads live buffers through (issue #53). The authority owns every open
 * buffer's text; this seam returns the CURRENT text of an open markdown
 * document, or undefined when the path is not an open markdown buffer. The
 * startup recovery of the journal restores the sidecars of the documents
 * through it.
 */
export type ReferenceDocumentAuthority = WorkspaceEditAuthority & JournalRecoveryAuthority;

/**
 * The slice of FSAL this provider actually consumes: the 'fsal-events'
 * subscription surface. The real FSAL satisfies it directly, and specs
 * inject a plain EventEmitter — no type escapes anywhere.
 */
import type { AnyDescriptor } from "@dts/common/fsal";

export interface ReferenceFSALEvents {
  on: (evt: "fsal-events", callback: (events: FSALEventPayload[]) => void) => void;
  off: (evt: "fsal-events", callback: (events: FSALEventPayload[]) => void) => void;
  getAllLoadedDescriptors?: () => Promise<AnyDescriptor[]>;
}

/** A scheduled deferred extraction that can be cancelled before it fires. */
export interface AuthorityReportTask {
  cancel: () => void;
}

/**
 * The injected deferred-execution seam. Production backs this with
 * setTimeout/clearTimeout; specs fire the recorded callbacks manually so the
 * debounce is proven headlessly without wall-clock waits.
 */
export interface AuthorityReportScheduler {
  schedule: (callback: () => void, delayMs: number) => AuthorityReportTask;
}

/** The production scheduler: plain setTimeout/clearTimeout. */
const setTimeoutScheduler: AuthorityReportScheduler = {
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

/**
 * Serves the merged workspace reference view (saved FSAL snapshots overlaid
 * by authority-derived live buffers) to every consumer over the
 * 'reference-provider' ipc channel.
 */
export default class ReferenceProvider extends ProviderContract {
  private readonly _index: ReferenceIndex;
  /** The one-shot pending workspace undo, if the last commit applied */
  private _pendingUndo: PendingUndo | undefined;
  /** Pending debounced extractions by documentPath */
  private readonly _pendingReports: Map<string, AuthorityReportTask>;
  private readonly _citationRequests = new Map<string, symbol>();
  private readonly _citationSources = new Map<string, string>();

  /**
   * Applies FSAL state transitions to the index: 'add'/'change' events
   * carrying a markdown file descriptor apply its FSAL-owned saved snapshot,
   * 'unlink' events remove the document's saved snapshot. One 'references'
   * broadcast announces a batch that changed the merged view.
   */
  private readonly _onFsalEvents = (events: FSALEventPayload[]): void => {
    let changed = false;
    for (const payload of events) {
      if (payload.event === "unlink") {
        changed = this._index.removeSavedSnapshot(payload.path) || changed;
      } else if (
        (payload.event === "add" || payload.event === "change") &&
        payload.descriptor.type === "file"
      ) {
        changed = this._index.applySavedSnapshot(payload.descriptor.references) || changed;
      }
    }
    if (changed) {
      broadcastIpcMessage("references");
    }
  };

  constructor(
    private readonly _logger: LogProvider,
    private readonly _fsal: ReferenceFSALEvents,
    private readonly _authority: ReferenceDocumentAuthority,
    private readonly _authorityReportDebounceMs: number,
    /** Application data directory holding the workspace-edit journal */
    private readonly _journalDirectory: string,
    private readonly _scheduler: AuthorityReportScheduler = setTimeoutScheduler,
  ) {
    super();
    this._index = new ReferenceIndex();
    this._pendingReports = new Map();

    ipcMain.handle("reference-provider", (_event, message: ReferenceProviderIPCAPI) => {
      const { command } = message;

      if (command === "get-snapshot") {
        return this._index.getSnapshot();
      }

      // Fail loud (issue #5, B20): a command outside the delegation map is
      // a caller bug, never a silently-undefined response. The renderer
      // report channel of the pre-#53 architecture lands here by design.
      throw new Error(`reference-provider: unknown command ${String(command)}`);
    });
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
  public reportAuthorityBuffer(filePath: string, immediate: boolean = false): void {
    this._pendingReports.get(filePath)?.cancel();
    this._pendingReports.set(
      filePath,
      this._scheduler.schedule(
        () => this._reportBufferNow(filePath),
        immediate ? 0 : this._authorityReportDebounceMs,
      ),
    );
  }

  /** Extracts the current authority text of a buffer into the overlay. */
  private _reportBufferNow(filePath: string): void {
    this._pendingReports.delete(filePath);

    const content = this._authority.readMarkdownBufferContent(filePath);
    if (content === undefined) {
      // The buffer closed between the change and the debounce firing:
      // the overlay follows the authority's open set.
      this.dropAuthorityBuffer(filePath);
      return;
    }

    const snapshot = extractReferences(filePath, content);
    if (this._citationSources.get(filePath) === snapshot.sourceHash) return;
    this._citationSources.set(filePath, snapshot.sourceHash);
    const request = Symbol(filePath);
    this._citationRequests.set(filePath, request);
    const citations = knownPandocCitations(content);
    if (citations !== undefined) {
      this._index.reportLiveBuffer({ ...snapshot, citations });
      broadcastIpcMessage("references");
      return;
    }
    this._index.reportLiveBuffer(snapshot);
    broadcastIpcMessage("references");
    const isCurrent = (): boolean => {
      const current = this._authority.readMarkdownBufferContent(filePath);
      return (
        this._citationRequests.get(filePath) === request &&
        current !== undefined &&
        hashDocumentSource(current) === snapshot.sourceHash
      );
    };
    void extractPandocCitations(content).then(
      (citations) => {
        if (!isCurrent()) return;
        this._index.reportLiveBuffer({ ...snapshot, citations });
        broadcastIpcMessage("references");
      },
      (error: Error) => {
        this._logger.error("[Reference Provider] Pandoc citation extraction failed", error);
        if (!isCurrent()) return;
        this._index.reportLiveBuffer({ ...snapshot, citationError: error.message });
        broadcastIpcMessage("references");
      },
    );
  }

  /**
   * Runs each pending extraction now, so the overlay holds the current
   * text of each open buffer.
   */
  private _flushAuthorityReports(): void {
    for (const [filePath, task] of [...this._pendingReports]) {
      task.cancel();
      this._reportBufferNow(filePath);
    }
  }

  /**
   * The document authority closed a buffer: cancel any pending extraction
   * and drop its overlay immediately, reverting the document to its saved
   * FSAL snapshot.
   *
   * @param   {string}  filePath  The closed document's path
   */
  public dropAuthorityBuffer(filePath: string): void {
    this._citationRequests.delete(filePath);
    this._citationSources.delete(filePath);
    this._pendingReports.get(filePath)?.cancel();
    this._pendingReports.delete(filePath);
    if (this._index.dropLiveBuffer(filePath)) {
      broadcastIpcMessage("references");
    }
  }

  /**
   * Subscribes to the injected FSAL's 'fsal-events' stream so saved snapshots
   * follow the on-disk workspace state, and finishes any workspace-edit
   * transaction a crash interrupted before the app reads a half-written
   * workspace.
   */
  public async boot(): Promise<void> {
    this._fsal.on("fsal-events", this._onFsalEvents);
    if (typeof this._fsal.getAllLoadedDescriptors === "function") {
      try {
        const descriptors = await this._fsal.getAllLoadedDescriptors();
        for (const descriptor of descriptors) {
          if (descriptor.type === "file" && descriptor.references !== undefined) {
            this._index.applySavedSnapshot(descriptor.references);
          }
        }
        broadcastIpcMessage("references");
      } catch (err: unknown) {
        this._logger.error(
          "[Reference Provider] Could not load initial descriptors from FSAL",
          err,
        );
      }
    }
    const restored = await recoverWorkspaceEditJournal(this._journalDirectory, this._authority);
    if (restored.length > 0) {
      this._logger.warning(
        `[Reference Provider] Restored ${restored.length} document(s) from an interrupted workspace edit`,
        restored,
      );
    }
  }

  /**
   * Returns the merged workspace reference state — the same state the ipc
   * surface serves.
   *
   * @return  {WorkspaceReferenceState}  The merged workspace reference state
   */
  public getSnapshot(): WorkspaceReferenceState {
    return this._index.getSnapshot();
  }

  /**
   * Previews the workspace rename of oldKey to newKey over the current
   * merged workspace state: each pending extraction of an open buffer runs
   * first, then the pure previewReferenceRename() gives the edit. The
   * preview reads the text of each document that the edit changes (the
   * buffer of an open document, the file of a closed one) and gives each
   * changed line before and after (#6). A text whose hash is not the one
   * the edit was computed from rejects: the edit would not be the one the
   * author sees.
   *
   * @param   {string}                  oldKey  The full key being renamed
   * @param   {string}                  newKey  The full replacement key
   *
   * @return  {Promise<ReferenceRenamePreview>}  The previewed edit or a typed rejection
   */
  public async previewRename(oldKey: string, newKey: string): Promise<ReferenceRenamePreview> {
    this._flushAuthorityReports();
    const result = previewReferenceRename(this._index.getSnapshot().snapshots, oldKey, newKey);
    if (result.status === "rejected") {
      return result;
    }
    const { edit } = result;
    const documents = await Promise.all(
      Object.entries(edit.expectedSourceHashes).map(async ([documentPath, expectedHash]) => {
        const source =
          this._authority.readMarkdownBufferContent(documentPath) ??
          (await readFile(documentPath, "utf-8").catch((cause: Error) => {
            throw new Error(`Could not read ${documentPath}: ${cause.message}`, { cause });
          }));
        if (hashDocumentSource(source) !== expectedHash) {
          throw new Error(
            trans("%s changed while the references were read. Do the rename again.", documentPath),
          );
        }
        const edits = edit.edits.filter((change) => change.documentPath === documentPath);
        return { documentPath, source, target: editedText(source, edits) };
      }),
    );
    return { status: "ok", edit, documents: previewOf(documents) };
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
  public async commitRename(edit: WorkspaceReferenceEdit): Promise<CommitRenameOutcome> {
    const result = await runWorkspaceEditTransaction(this._authority, this._journalDirectory, {
      edits: edit.edits,
      expectedSourceHashes: edit.expectedSourceHashes,
    });

    if (result.status === "conflict") {
      return {
        status: "conflict",
        conflict: {
          status: "conflict",
          documentPath: result.documentPath,
          expectedSourceHash: result.expectedSourceHash,
          actualSourceHash: result.actualSourceHash,
        },
      };
    }

    this._pendingUndo = {
      edits: edit.undo,
      documentPaths: Object.keys(edit.expectedSourceHashes),
      expectedSourceHashes: result.resultingHashes,
    };

    broadcastIpcMessage("references");

    return {
      status: "applied",
      closedFilesWritten: result.closedFilesWritten,
      openBuffersUpdated: result.openBuffersUpdated,
    };
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
  public async undoRename(): Promise<UndoRenameOutcome> {
    const pending = this._pendingUndo;
    if (pending === undefined) {
      return { status: "no-pending-undo" };
    }

    const result = await runWorkspaceEditTransaction(this._authority, this._journalDirectory, {
      edits: pending.edits,
      expectedSourceHashes: pending.expectedSourceHashes,
    });

    if (result.status === "conflict") {
      return {
        status: "conflict",
        conflict: {
          status: "conflict",
          documentPath: result.documentPath,
          expectedSourceHash: result.expectedSourceHash,
          actualSourceHash: result.actualSourceHash,
        },
      };
    }

    // One-shot: the applied undo consumes the record.
    this._pendingUndo = undefined;

    broadcastIpcMessage("references");

    return {
      status: "applied",
      closedFilesWritten: result.closedFilesWritten,
      openBuffersUpdated: result.openBuffersUpdated,
    };
  }

  /**
   * Shuts down the service provider, unsubscribing from FSAL events and
   * cancelling every pending debounced report.
   */
  public async shutdown(): Promise<void> {
    this._citationRequests.clear();
    this._citationSources.clear();
    this._fsal.off("fsal-events", this._onFsalEvents);
    for (const task of this._pendingReports.values()) {
      task.cancel();
    }
    this._pendingReports.clear();
    this._logger.verbose("Reference provider shutting down ...");
  }
}
