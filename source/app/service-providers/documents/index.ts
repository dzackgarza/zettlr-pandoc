/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DocumentManager
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This controller represents all open files that are displayed
 *                  in the app. It will stay in sync with the configuration's
 *                  open files setting and emit events as necessary. The
 *                  renderer's equivalent is the editor and the tabs.
 *
 * END HEADER
 */

import { ChangeSet, Text } from "@codemirror/state";
import { trans } from "@common/i18n-main";
import { markdownToAST } from "@common/modules/markdown-utils";
import PersistentDataContainer from "@common/modules/persistent-data-container";
import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import { countAll } from "@common/util/counter";
import errorToString from "@common/util/error-to-string";
import isFile from "@common/util/is-file";
import serializeChangeSet from "@common/util/serialize-change-set";
import {
  type BranchNodeJSON,
  DocumentType,
  DP_EVENTS,
  type LeafNodeJSON,
  type OpenDocument,
  type SerializedUpdate,
} from "@dts/common/documents";
import {
  SAVE_REFUSED_CHANNEL,
  type SaveFileResult,
  type SaveRefusal,
  type SaveRefusedBroadcast,
} from "@dts/common/documents";
import type { CodeFileDescriptor, MDFileDescriptor } from "@dts/common/fsal";
import type { DocumentLocation, SourceRange } from "@dts/common/references";
import type { ReviewState } from "@dts/common/agent-api";
import type { ReviewDiffSession, ReviewDiffStatus } from "@dts/common/review-diff";
import { type TabManager } from "@providers/documents/document-tree/tab-manager";
import type { ConfigOptions } from "@providers/config/get-config-template";
import ProviderContract, { type IPCAPI } from "@providers/provider-contract";
import { randomUUID } from "crypto";
import { app, type BrowserWindow, dialog, ipcMain, type MessageBoxOptions, shell } from "electron";
import EventEmitter from "events";
import { constants as FSConstants } from "fs";
import path from "path";
import { normalizeText, sha256Text } from "./review-diff-store";
import {
  getDocumentTypeForExtension,
  hasImageExt,
  hasMdOrCodeExt,
  hasPDFExt,
} from "source/common/util/file-extention-checks";
import isDir from "source/common/util/is-dir";
import { v4 as uuid4 } from "uuid";
import { type AppServiceContainer } from "../../app-service-container";
import { DocumentTree, type DTLeaf } from "./document-tree";
import { ReviewDiffStore } from "./review-diff-store";

type DocumentWindows = Record<string, DocumentTree>;
type DocumentWindowsJSON = Record<string, BranchNodeJSON | LeafNodeJSON>;

interface DocumentWatchdog {
  on(event: "change", listener: (event: unknown, filePath: unknown) => void): void;
  getWatched(): Record<string, string[]>;
  watchPath(filePath: string): void;
  unwatchPath(filePath: string): void;
  shutdown(): Promise<void>;
}

type DocumentManagerConfig = {
  get(): {
    app: Pick<ConfigOptions["app"], "openFiles" | "openWorkspaces">;
    editor: Pick<ConfigOptions["editor"], "autoSave">;
    system: Pick<ConfigOptions["system"], "avoidNewTabs">;
    appLang: ConfigOptions["appLang"];
    files: {
      images: Pick<ConfigOptions["files"]["images"], "openWith">;
      pdf: Pick<ConfigOptions["files"]["pdf"], "openWith">;
    };
    alwaysReloadFiles: ConfigOptions["alwaysReloadFiles"];
  };
  addPath: AppServiceContainer["config"]["addPath"];
  set: AppServiceContainer["config"]["set"];
};

type DocumentManagerApp = {
  citeproc: Pick<AppServiceContainer["citeproc"], "synchronizeDatabases">;
  config: DocumentManagerConfig;
  fsal: {
    getWatchdog(): DocumentWatchdog;
    getFilesystemMetadata(filePath: string): Promise<{ modtime: number }>;
  } & Pick<
    AppServiceContainer["fsal"],
    | "getDescriptorFor"
    | "getDescriptorForAnySupportedFile"
    | "loadAnySupportedFile"
    | "readDirectoryRecursively"
    | "testAccess"
    | "writeTextFile"
  >;
  log: Pick<AppServiceContainer["log"], "error" | "info" | "verbose" | "warning">;
  recentDocs: Pick<AppServiceContainer["recentDocs"], "add">;
  stats: Pick<AppServiceContainer["stats"], "updateCounts">;
  windows: Pick<
    AppServiceContainer["windows"],
    "askSaveChanges" | "getFirstMainWindow" | "getMainWindowKey"
  >;
};

// Keep no more than this many updates.
const MAX_VERSION_HISTORY = 100;
// Delayed timeout means: Save after 5 seconds
const DELAYED_SAVE_TIMEOUT = 5000;
// Even "immediate" should not save immediately to prevent race conditions on slower systems
const IMMEDIATE_SAVE_TIMEOUT = 500;

export interface DocumentsUpdateContext {
  windowId?: string;
  leafId?: string;
  filePath?: string;
  direction?: "horizontal" | "vertical";
  insertion?: "after" | "before";
  newLeaf?: string;
  originLeaf?: string;
  key?: string;
  status?: "modification" | "pinned";
  /**
   * Additive (issue #1 Phase 5): the exact DocumentLocation to restore in
   * the renderer when a Back/Forward navigation restored a stamped history
   * entry. Only ever present on ACTIVE_FILE events.
   */
  location?: DocumentLocation;
  /**
   * Additive (issue #1 Phase 5): the definition range to land on after a
   * cross-file reference jump. Only ever present on ACTIVE_FILE events.
   */
  targetRange?: SourceRange;
  /**
   * Additive (issue #34): a validated single-document diff proposition to
   * mount in the active editor. For REVIEW_DIFF broadcasts, windowId/leafId
   * identify the source pane whose status update has already applied locally.
   */
  reviewDiffSession?: ReviewDiffSession;
  /** Signal that a review was closed/completed/invalidated (spec section 13). */
  reviewCleared?: boolean;
  /** The reviewId that was cleared, for renderer session matching. */
  reviewId?: string;
  /** Provider-owned review state (spec section 7). Replaces the old scalar. */
  reviewState?: {
    reviewId: string;
    generation: number;
    referenceText: string;
    workingText: string;
    unresolvedChunks: number;
  };
  /**
   * The renderer-ready failure payload for FILE_REMOTE_CHANGE_ERROR events.
   * The message is suitable for the visible error surface; diagnostic retains
   * the complete stack or serialized rejection for renderer diagnostics.
   */
  documentLoadError?: {
    message: string;
    diagnostic: string;
  };
}

/**
 * Holds all information associated with a document that is currently loaded
 */
interface Document {
  /**
   * Opaque document identifier (spec section 4). Stable for the lifetime of
   * a loaded document; used as the key for all agent API operations.
   */
  documentId: string;
  /**
   * The absolute path to the file
   */
  filePath: string;
  /**
   * The descriptor for the file
   */
  descriptor: MDFileDescriptor | CodeFileDescriptor;
  /**
   * The file type (e.g. Markdown, JSON, YAML)
   */
  type: DocumentType;
  /**
   * The current version of the document in memory
   */
  currentVersion: number;
  /**
   * The last version for which full updates are available. Editors with a
   * version less than minimumVersion will need to reload the document.
   */
  minimumVersion: number;
  /**
   * The last version number that has been saved to disk. If lastSavedVersion
   * === currentVersion, the file is not modified. NOTE: DO NOT ASSUME THIS
   * VARIABLE TO ACCURATELY REFLECT THE PRECISE VERSION THAT HAS BEEN SAVED;
   * THIS VARIABLE MAY DIFFER, AND EVEN GET NEGATIVE! ONLY USE THIS TO COMPARE
   * AGAINST CURRENTVERSION!
   */
  lastSavedVersion: number;
  /**
   * This is a duplicate of whatever has been last written to disk. It is used
   * to double check whether a change event actually changed the content of a
   * file or if the file remains the same on disk as in buffer.
   */
  lastSavedContent: string;
  /**
   * Holds all updates between minimumVersion and currentVersion in a granular
   * form.
   */
  updates: SerializedUpdate[];
  /**
   * The actual document text in a CodeMirror format.
   */
  document: Text;
  /**
   * Necessary for the word count statistics: The amount of words when the file
   * was last saved to disk.
   */
  lastSavedWordCount: number;
  /**
   * Necessary for the word count statistics: The amount of characters when the
   * file was last saved to disk.
   */
  lastSavedCharCount: number;
  /**
   * Holds an optional save timeout. This is for when users have indicated they
   * want autosaving.
   */
  saveTimeout: undefined | NodeJS.Timeout;
}

interface SubmittedProposalResponse {
  ok: true;
  packetId: string;
  reviewId: string;
  documentId: string;
  documentRevision: { version: number; sha256: string };
  reviewGeneration: number;
  unresolvedChunks: number;
  state: ReviewState;
}

interface ProposalIdempotencyRecord {
  fingerprint: string;
  response: SubmittedProposalResponse;
}

export type DocumentAuthorityIPCAPI = IPCAPI<{
  "get-document": { filePath: string };
  "pull-updates": { filePath: string; version: number };
  "push-updates": { filePath: string; version: number; updates: SerializedUpdate[] };
}>;

/**
 * Why a save was refused. The provider never presents this itself: a blocking
 * `dialog.showErrorBox` freezes the main process until it is dismissed, which
 * is both hostile to the user and unobservable to any automated driver. The
 * renderer owns presentation and surfaces these as closable toasts, matching
 * the rule recorded in win-main/util/recoverable-reference-errors.ts.
 */
// These cross IPC, so @dts/common/documents owns them; re-exported here
// because callers throughout main import them from the provider.
export type {
  SaveFileResult,
  SaveRefusal,
  SaveRefusalReason,
  SaveRefusedBroadcast,
} from "@dts/common/documents";
export { SAVE_REFUSED_CHANNEL } from "@dts/common/documents";

// Most document manager commands require a leaf location, described by the
// window and leaf IDs.
type LeafLoc = { windowId: string; leafId: string };
export type DocumentManagerIPCAPI = IPCAPI<{
  "set-pinned": LeafLoc & { path: string; pinned: boolean };
  "retrieve-tab-config": { windowId: string };
  "save-file": { path: string };
  // targetRange/sourceLocation are additive (issue #1 Phase 5): a reference
  // jump lands on targetRange in the opened document and stamps the origin
  // pane's current history entry with sourceLocation so Back can restore it.
  "open-file": LeafLoc & {
    path: string;
    newTab: boolean;
    targetRange?: SourceRange;
    sourceLocation?: DocumentLocation;
  };
  "close-file": LeafLoc & { path: string };
  "close-file-everywhere": { path: string };
  "get-open-workspace-files": { path: string };
  "get-workspace-files": { path: string };
  "sort-open-files": LeafLoc & { newOrder: string[] };
  "get-file-modification-status": unknown;
  "get-review-diff-session": { path: string };
  "set-review-diff-status": Omit<ReviewDiffStatus, "filePath"> & {
    path: string;
  };

  "move-file": {
    originWindow: string;
    targetWindow: string;
    originLeaf: string;
    targetLeaf: string;
    path: string;
  };
  "split-leaf": {
    originWindow: string;
    originLeaf: string;
    direction: "horizontal" | "vertical";
    insertion: "before" | "after";
    path?: string;
    fromWindow?: string;
    fromLeaf?: string;
  };
  "close-leaf": LeafLoc;
  "focus-leaf": LeafLoc;
  "set-branch-sizes": { windowId: string; branchId: string; sizes: number[] };
  // location is additive (issue #1 Phase 5): the current DocumentLocation of
  // the navigating pane, stamped onto the current history entry before the
  // move so the opposite direction can restore it.
  "navigate-forward": LeafLoc & { location?: DocumentLocation };
  "navigate-back": LeafLoc & { location?: DocumentLocation };
  // Additive (issue #1 Phase 5): whether the leaf's session history has
  // entries before/after the pointer (Back/Forward enabled state).
  "get-navigation-state": LeafLoc;
}>;

export default class DocumentManager extends ProviderContract {
  /**
   * This array holds all open windows, here represented as document trees
   *
   * @var {DocumentTree[]}
   */
  private readonly _windows: DocumentWindows;
  /**
   * The event emitter helps broadcast events across the main process
   *
   * @var {EventEmitter}
   */
  private readonly _emitter: EventEmitter;
  /**
   * The config file container persists the document tree data to disk so that
   * open editor panes & windows can be restored
   *
   * @var {PersistentDataContainer<DocumentWindowsJSON>}
   */
  private readonly _config: PersistentDataContainer<DocumentWindowsJSON>;
  /**
   * The process that watches currently opened files for remote changes
   *
   * @var {chokidar.FSWatcher}
   */
  private readonly _watcher: DocumentWatchdog;

  /**
   * Holds a list of strings for files that have recently been saved by the
   * user. For those files, we need to ignore remote changes since they
   * originate here.
   *
   * @var {string[]}
   */
  private readonly _ignoreChanges: string[];

  /**
   * This array allows us to prevent showing multiple "Reload changes?" dialogs
   * for a single file open in the app.
   *
   * @var {string[]}
   */
  private readonly _remoteChangeDialogShownFor: string[];

  /**
   * Provider-owned authoritative review state (spec section 7). Replaces the
   * old _reviewDiffSessions map. The store owns referenceText, workingText,
   * packet ledger, and review generation.
   */
  private readonly _reviewStore: ReviewDiffStore;

  /** Path → documentId mapping for agent API lookups. */
  private readonly _documentIdByPath: Map<string, string>;

  /** Successful proposal responses, keyed by document and client idempotency key. */
  private readonly _proposalIdempotency: Map<string, ProposalIdempotencyRecord>;

  /**
   * This holds all currently opened documents somewhere across the app.
   *
   * @var {Document[]}
   */
  private readonly documents: Document[];

  private _shuttingDown: boolean;

  private readonly _lastEditor: {
    windowId: string | undefined;
    leafId: string | undefined;
  };

  constructor(private readonly _app: DocumentManagerApp) {
    super();

    const containerPath = path.join(app.getPath("userData"), "documents.yaml");

    this._windows = {};
    this._emitter = new EventEmitter();
    this._config = new PersistentDataContainer(containerPath, "yaml");
    this._ignoreChanges = [];
    this._remoteChangeDialogShownFor = [];
    this._reviewStore = new ReviewDiffStore();
    this._documentIdByPath = new Map();
    this._proposalIdempotency = new Map();
    this.documents = [];
    this._shuttingDown = false;
    this._lastEditor = {
      windowId: undefined,
      leafId: undefined,
    };

    // Start up the chokidar process
    this._watcher = this._app.fsal.getWatchdog();

    this._watcher.on("change", (event, filePath) => {
      const changeEvent: unknown = event;
      const changedPath: unknown = filePath;
      if (typeof changedPath !== "string") {
        this._app.log.warning("[DocumentManager] Ignoring watchdog change with a non-string path.");
        return;
      }
      if (changeEvent !== "unlink" && changeEvent !== "change") {
        this._app.log.warning(
          `[DocumentManager] Received unexpected event ${String(changeEvent)} for ${changedPath}.`,
        );
        return;
      }
      if (this._ignoreChanges.includes(changedPath) && changeEvent === "change") {
        this._app.log.info(`[DocumentManager] Ignoring change for ${changedPath}`);
        this._ignoreChanges.splice(this._ignoreChanges.indexOf(changedPath), 1);
        return;
      } else {
        this._app.log.info(`[DocumentManager] Processing ${changeEvent} for ${changedPath}`);
      }

      if (changeEvent === "unlink") {
        // Close the file everywhere
        this.closeFileEverywhere(changedPath).catch((err: unknown) =>
          this._app.log.error(err instanceof Error ? err.message : String(err)),
        );
      } else {
        this.handleRemoteChange(changedPath).catch((err: unknown) => {
          const diagnostic = errorToString(err);
          this._app.log.error(
            `[DocumentManager] Could not reload changed file ${changedPath}`,
            err,
          );
          this.broadcastEvent(DP_EVENTS.FILE_REMOTE_CHANGE_ERROR, {
            filePath: changedPath,
            documentLoadError: {
              message: err instanceof Error ? err.message : diagnostic,
              diagnostic,
            },
          });
        });
      }
    });

    /**
     * Hook the event listener that directly communicates with the editors
     */
    ipcMain.handle("documents-authority", async (event, message: DocumentAuthorityIPCAPI) => {
      const { command, payload } = message;
      switch (command) {
        case "pull-updates":
          return await this.pullUpdates(payload.filePath, payload.version);
        case "push-updates":
          return await this.pushUpdates(payload.filePath, payload.version, payload.updates);
        case "get-document":
          return await this.getDocument(payload.filePath);
      }
    });

    // Finally, listen to events from the renderer
    ipcMain.handle("documents-provider", async (event, message: DocumentManagerIPCAPI) => {
      const { command, payload } = message;
      switch (command) {
        // A given tab should be set as pinned
        case "set-pinned": {
          const { windowId, leafId, path, pinned } = payload;
          this.setPinnedStatus(windowId, leafId, path, pinned);
          return;
        }
        // Some main window has requested its tab/split view state
        case "retrieve-tab-config": {
          return this._windows[payload.windowId].toJSON();
        }
        case "save-file": {
          return await this.saveFile(payload.path);
        }
        case "open-file": {
          const { windowId, leafId, path, newTab, targetRange, sourceLocation } = payload;
          return await this.openFile(windowId, leafId, path, newTab, {
            targetRange,
            sourceLocation,
          });
        }
        case "close-file": {
          const { windowId, leafId, path } = payload;
          return await this.closeFile(windowId, leafId, path);
        }
        case "close-file-everywhere": {
          const { path } = payload;
          return this.closeFileEverywhere(path);
        }
        case "get-open-workspace-files": {
          const { path } = payload;
          return this.getFilesForWorkspace(path);
        }
        case "sort-open-files": {
          const { windowId, leafId, newOrder } = payload;
          this.sortOpenFiles(windowId, leafId, newOrder);
          return;
        }
        case "get-file-modification-status": {
          return this.documents.filter((x) => this.isModified(x.filePath)).map((x) => x.filePath);
        }
        case "get-review-diff-session": {
          const docId = this.getDocumentId(payload.path);
          if (docId === undefined) {
            return undefined;
          }
          const review = this._reviewStore.getReview(docId);
          if (review === undefined) {
            return undefined;
          }
          // Construct legacy ReviewDiffSession for renderer compat
          return {
            id: review.reviewId,
            reviewGeneration: review.generation,
            documentPath: payload.path,
            baselineSha256: sha256Text(review.baselineText),
            diskBaselineSha256: review.diskFenceSha256,
            baselineText: review.baselineText,
            originalText: review.referenceText,
            proposedText: review.workingText,
            currentText: review.workingText,
          } as ReviewDiffSession;
        }
        case "set-review-diff-status": {
          const {
            path,
            sessionId,
            unresolvedChunks,
            originalText,
            currentText,
            documentVersion,
            sourceWindowId,
            sourceLeafId,
            reviewGeneration,
          } = payload;
          return this.setReviewDiffStatus({
            filePath: path,
            sessionId,
            unresolvedChunks,
            originalText,
            currentText,
            documentVersion,
            sourceWindowId,
            sourceLeafId,
            reviewGeneration,
          });
        }
        case "move-file": {
          const { originWindow, originLeaf, targetWindow, targetLeaf, path } = payload;
          return await this.moveFile(originWindow, targetWindow, originLeaf, targetLeaf, path);
        }
        case "split-leaf": {
          const { originWindow, originLeaf, direction, insertion, path, fromWindow, fromLeaf } =
            payload;

          return await this.splitLeaf(
            originWindow,
            originLeaf,
            direction,
            insertion,
            path,
            fromWindow,
            fromLeaf,
          );
        }
        case "close-leaf": {
          return this.closeLeaf(payload.windowId, payload.leafId);
        }
        case "focus-leaf": {
          return this._updateFocusLeaf(payload.windowId, payload.leafId);
        }
        case "set-branch-sizes": {
          // NOTE that in this particular instance we do not emit an event. The
          // reason is that we need to prevent frequent reloads during resizing.
          // For as long as the window is open, the window will have the correct
          // sizes, and will only update those sizes here in the main process.
          // As soon as the window is closed, however, it will automatically
          // grab the correct sizes again.
          const branch = this._windows[payload.windowId].findBranch(payload.branchId);
          if (branch !== undefined) {
            branch.sizes = payload.sizes;
            this.syncToConfig();
          }
          return;
        }
        case "navigate-forward": {
          return await this.navigateForward(payload.windowId, payload.leafId, payload.location);
        }
        case "navigate-back": {
          return await this.navigateBack(payload.windowId, payload.leafId, payload.location);
        }
        case "get-navigation-state": {
          return this.getNavigationState(payload.windowId, payload.leafId);
        }
      }
    });

    // Listen to the before-quit event by which we make sure to only quit the
    // application if the status of possibly modified files has been cleared.
    // We listen to this event, because it will fire *before* the process
    // attempts to close the open windows, including the main window, which
    // would result in a loss of data. NOTE: The exception is the auto-updater
    // which will close the windows before this event. But because we also
    // listen to close-events on the main window, we should be able to handle
    // this, if we ever switched to the auto updater.
    app.on("before-quit", (event) => {
      if (!this.isClean()) {
        event.preventDefault();

        // NOTE: We are re-implementing `askSaveChanges` here since we cannot
        // give the user the choice to cancel.
        // TODO: Once the window management logic is put here, we have better
        // control over the windows and can ask this question *before* the
        // window is being closed.
        const opt: MessageBoxOptions = {
          type: "question",
          buttons: [trans("Save changes"), trans("Discard changes"), trans("Cancel")],
          defaultId: 0,
          cancelId: 2,
          title: trans("Unsaved changes"),
          message: trans("There are unsaved changes. Do you want to save or discard them?"),
        };

        dialog
          .showMessageBox(opt)
          .then(async ({ response }) => {
            // 0 = Save, 1 = Don't save, 2 = Cancel
            if (response === 2) {
              this._app.log.verbose("User cancelled save-dialog; not quitting.");
              return; // Do nothing
            }

            // Apply the choice to all open documents
            for (const document of this.documents) {
              if (response === 0) {
                const saved = await this.saveFile(document.filePath);
                if (!saved.ok) {
                  this._announceSaveRefusal(document.filePath, saved);
                  return;
                }
              } else {
                document.lastSavedVersion = document.currentVersion;
                this._closeReview(document.documentId);
              }
            }

            app.quit();
          })
          .catch((err) => {
            this._app.log.error("[DocumentManager] Cannot ask user to save or omit changes!", err);
          });
      } else {
        this._shuttingDown = true;
      }
    });
  } // END constructor

  /**
   * Use this method to ask the user whether or not the window identified with
   * the windowId may be closed. If this function returns true, the user agreed
   * to drop all changes, or there were no changes contained in the window.
   *
   * @param   {string}            windowId  The window in question
   *
   * @return  {Promise<boolean>}            Returns false if the window may not be closed
   */
  public async askUserToCloseWindow(windowId: string): Promise<boolean> {
    if (this.isClean(windowId)) {
      return true;
    }

    // TODO: Check if the same (modified) files are also open in other windows.
    // If so, we can treat this window as if it contains no changes, since the
    // document is still open somewhere else.

    const result = await this._app.windows.askSaveChanges();
    // 0 = Save, 1 = Don't save, 2 = Cancel
    if (result.response === 1) {
      // Mark everything as clean TODO: As of now this would mean that if the
      // documents are open in other windows, they would still reflect the
      // "wrong" (b/c omitted, unsaved) state!
      for (const document of this.documents) {
        document.lastSavedVersion = document.currentVersion;
      }

      // If we're not shutting down, this function will only be called for when
      // the user wants to actively close a window for good
      if (!this._shuttingDown) {
        this.closeWindow(windowId);
      }

      return true;
    } else if (result.response === 0) {
      // Save all docs
      for (const document of this.documents) {
        const saved = await this.saveFile(document.filePath);
        if (!saved.ok) {
          this._announceSaveRefusal(document.filePath, saved);
          return false;
        }
      }

      // If we're not shutting down, this function will only be called for when
      // the user wants to actively close a window for good
      if (!this._shuttingDown) {
        this.closeWindow(windowId);
      }

      return true;
    } else {
      return false;
    }
  }

  async boot(): Promise<void> {
    // Loads in all openFiles
    this._app.log.verbose("Document Manager starting up ...");

    // Check if the data store is initialized
    if (!(await this._config.isInitialized())) {
      this._app.log.info("[Document Manager] Initializing document storage ...");
      const tree = new DocumentTree();
      const key = uuid4();
      await this._config.init({ [key]: tree.toJSON() });
    }

    const treedata = await this._config.get();
    for (const key in treedata) {
      try {
        // Make sure to fish out invalid paths before mounting the tree
        const tree = DocumentTree.fromJSON(treedata[key]);
        for (const leaf of tree.getAllLeafs()) {
          for (const file of leaf.tabMan.openFiles.map((x) => x.path)) {
            if (
              !(await this._app.fsal.testAccess(
                file,
                FSConstants.F_OK | FSConstants.W_OK | FSConstants.R_OK,
              ))
            ) {
              leaf.tabMan.closeFile(file);
            }
          }
          if (leaf.tabMan.openFiles.length === 0) {
            leaf.parent.removeNode(leaf);
          }
        }
        this._windows[key] = tree;
        this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key });
      } catch (err: unknown) {
        if (err instanceof Error) {
          this._app.log.error(
            `[Document Provider] Could not instantiate window ${key}: ${err.message}`,
            err,
          );
        } else {
          this._app.log.error(
            `[Document Provider] Could not instantiate window ${key}: Unknown error`,
            err,
          );
        }
      }
    }

    if (Object.keys(treedata).length === 0) {
      this._app.log.warning("[Document Manager] Creating new window since all are closed.");
      const key = uuid4();
      this._windows[key] = new DocumentTree();
      this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key });
    }

    // Sync everything after boot
    this.syncWatchedFilePaths();
    await this.synchronizeDatabases();
    this.syncToConfig();

    this._app.log.info(`[Document Manager] Restored ${this.windowCount()} open windows.`);
  }

  public windowCount(): number {
    return Object.keys(this._windows).length;
  }

  public windowKeys(): string[] {
    return Object.keys(this._windows);
  }

  public leafIds(windowId: string): string[] {
    if (!(windowId in this._windows)) {
      return [];
    }

    return this._windows[windowId].getAllLeafs().map((leaf) => leaf.id);
  }

  public newWindow(): void {
    const newTree = new DocumentTree();
    const existingKeys = Object.keys(this._windows);
    let key = uuid4();
    while (existingKeys.includes(key)) {
      key = uuid4();
    }

    this._windows[key] = newTree;
    this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key });
    this.syncToConfig();
  }

  public closeWindow(windowId: string): void {
    if (this._shuttingDown) {
      return; // During shutdown only the WindowManager should close windows
    }

    const isLastWindow = Object.values(this._windows).length === 1;

    if (windowId in this._windows && !isLastWindow) {
      // NOTE: By doing this, we always retain the window state of the last and
      // only window that is open. This means that, while additional windows
      // will be forgotten after closing, the last and final one will always
      // retain its state.
      // TODO: If we ever implement workspaces, etc., this safeguard won't be
      // necessary anymore.
      this._app.log.info(`[Documents Manager] Closing window ${windowId}!`);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._windows[windowId];
      this.syncToConfig();
    }
  }

  // Enable global event listening to updates of the config
  on(evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.on(evt, callback);
  }

  once(evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.once(evt, callback);
  }

  // Also do the same for the removal of listeners
  off(evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.off(evt, callback);
  }

  async shutdown(): Promise<void> {
    // We MUST under all circumstances properly call the close() function on
    // every chokidar process we utilize. Otherwise, the fsevents dylib will
    // still hold on to some memory after the Electron process itself shuts down
    // which will result in a crash report appearing on macOS.
    await this._watcher.shutdown();
    this._config.shutdown();
  }

  private broadcastEvent(event: DP_EVENTS, context?: DocumentsUpdateContext): void {
    // Here we blast an event notification across every line of code of the app
    broadcastIpcMessage("documents-update", { event, context });
    this._emitter.emit(event, context);
  }

  // DOCUMENT AUTHORITY FUNCTIONS

  public async getDocument(
    filePath: string,
  ): Promise<{ content: string; type: DocumentType; startVersion: number }> {
    const existingDocument = this.documents.find((doc) => doc.filePath === filePath);
    if (existingDocument !== undefined) {
      return {
        content: existingDocument.document.toString(),
        type: existingDocument.type,
        startVersion: existingDocument.currentVersion,
      };
    }

    // TODO: We also need to be able to load files not present in the file tree!
    const descriptor = await this._app.fsal.getDescriptorForAnySupportedFile(filePath);
    if (descriptor === undefined || descriptor.type === "other") {
      throw new Error(`Cannot load file ${filePath}`); // TODO: Proper error handling & state recovery!
    }

    const content = await this._app.fsal.loadAnySupportedFile(filePath);

    let type = DocumentType.Markdown;

    if (descriptor.type === "code") {
      const codeDocumentType = getDocumentTypeForExtension(descriptor.path);
      if (codeDocumentType !== undefined) {
        type = codeDocumentType;
      }
    }

    const doc: Document = {
      documentId: this._assignDocumentId(filePath),
      filePath,
      type,
      descriptor,
      currentVersion: 0,
      minimumVersion: 0,
      lastSavedVersion: 0,
      lastSavedContent: content,
      updates: [],
      document: Text.of(content.split("\n")),
      lastSavedCharCount: descriptor.type === "file" ? descriptor.charCount : 0,
      lastSavedWordCount: descriptor.type === "file" ? descriptor.wordCount : 0,
      saveTimeout: undefined,
    };

    this.documents.push(doc);
    this.syncWatchedFilePaths();

    return { content, type, startVersion: 0 };
  }

  private async pullUpdates(filePath: string, clientVersion: number): Promise<SerializedUpdate[] | false> {
    const doc = this.documents.find((doc) => doc.filePath === filePath);
    if (doc === undefined) {
      // Indicate to the editor that they should get the document (again). This
      // handles the case where the document has been remotely modified and thus
      // removed from the document array.
      return false;
    }

    if (clientVersion < doc.minimumVersion || clientVersion > doc.currentVersion) {
      // The client is completely out of sync and has to reload the document.
      // If this happens because clientVersion < doc.minimumVersion, this means
      // that the lost connection somehow. If it happens because clientVersion
      // > doc.currentVersion, it means that we had to roll over the version in
      // pushUpdates below.
      return false;
    } else if (clientVersion < doc.currentVersion) {
      return doc.updates.slice(clientVersion - doc.minimumVersion);
    } else {
      return []; // No updates available
    }
  }

  private async pushUpdates(
    filePath: string,
    clientVersion: number,
    clientUpdates: SerializedUpdate[],
  ): Promise<boolean> {
    // clientUpdates must be produced via "toJSON"
    const doc = this.documents.find((doc) => doc.filePath === filePath);
    if (doc === undefined) {
      throw new Error(`Could not receive updates for file ${filePath}: Not found.`);
    }

    if (clientVersion !== doc.currentVersion) {
      return false;
    }

    // Before applying any updates, we have to clear any potential timeout so
    // that it does not interfere with us updating the document. Otherwise, this
    // can lead to a faulty state where the provider cannot save the file
    // anymore.
    clearTimeout(doc.saveTimeout);

    for (const update of clientUpdates) {
      const changes = ChangeSet.fromJSON(update.changes);
      doc.updates.push(update);
      try {
        doc.document = changes.apply(doc.document);
      } catch (err: unknown) {
        dialog.showErrorBox(
          "Document out of sync",
          `Your modifications could not be applied to the document in memory.
This means that saving might fail. Please report this bug to us, copy the
current contents from the editor somewhere else, and restart the application.`,
        );
        throw err;
      }
      doc.currentVersion = doc.minimumVersion + doc.updates.length;
      // People are lazy, and hence there is a non-zero chance that in a few
      // instances the currentVersion will get dangerously close to
      // Number.MAX_SAFE_INTEGER. In that case, we need to perform a rollback to
      // version 0 and notify all editors that have the document in question
      // open to simply re-load it. That will cause a screen-flicker, but
      // honestly better like this than otherwise.
      if (doc.currentVersion === Number.MAX_SAFE_INTEGER - 1) {
        console.warn(`Document ${filePath} has reached MAX_SAFE_INTEGER. Performing rollback ...`);
        doc.minimumVersion = 0;
        doc.currentVersion = doc.updates.length;
        // TODO: Broadcast a message so that all editor instances can reload the
        // document.
      }
    }

    // Notify all clients, they will then request the update
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      filePath,
      status: "modification",
    });

    // Drop all updates that exceed the amount of updates we allow.
    while (doc.updates.length > MAX_VERSION_HISTORY) {
      doc.updates.shift();
      doc.minimumVersion += 1;
    }

    const _docId = this.getDocumentId(filePath);
    if (_docId !== undefined && this._reviewStore.getReview(_docId) !== undefined) {
      return true;
    }

    const autoSave = this._app.config.get().editor.autoSave;

    // No autosave
    if (autoSave === "off") {
      return true;
    }

    doc.saveTimeout = setTimeout(
      () => {
        this.saveFile(doc.filePath)
          .then((result) => {
            if (result.ok) {
              return;
            }
            // A refusal resolves; only disk errors reject. Without this branch
            // the autosave timer swallowed refusals entirely: the review gate
            // above returns early for an open review, but a disk-changed
            // refusal reaches here, and the document stayed dirty with nothing
            // recorded anywhere. The buffer is preserved either way — this
            // makes the reason findable instead of inventing a silent success.
            const reason =
              result.refusal === undefined
                ? "no reason reported"
                : `${result.refusal.reason}: ${result.refusal.message}`;
            this._app.log.warning(
              `[Document Provider] Autosave refused for ${doc.filePath} (${reason}). ` +
                "The buffer is unchanged and still unsaved; the next explicit save will " +
                "surface this to the user.",
            );
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this._app.log.error(
              `[Document Provider] Could not save file ${doc.filePath}: ${message}`,
              err,
            );
          });
      },
      autoSave === "delayed" ? DELAYED_SAVE_TIMEOUT : IMMEDIATE_SAVE_TIMEOUT,
    );

    return true;
  }

  // END DOCUMENT AUTHORITY FUNCTIONS

  /**
   * This function searches all currently opened documents for files that have
   * databases attached to them, and announces to the citeproc provider that it
   * should keep those available. Resolves once the citeproc provider finishes
   * synchronizing.
   */
  private async synchronizeDatabases(): Promise<void> {
    const libraries: string[] = [];

    for (const doc of this.documents) {
      if (doc.descriptor.type !== "file") {
        continue;
      }

      const frontmatter: unknown = doc.descriptor.frontmatter;
      if (
        frontmatter !== null &&
        typeof frontmatter === "object" &&
        "bibliography" in frontmatter
      ) {
        const bib = frontmatter.bibliography;
        if (typeof bib === "string" && path.isAbsolute(bib)) {
          libraries.push(bib);
        }
      }
    }

    await this._app.citeproc.synchronizeDatabases(libraries);
  }

  /**
   * Opens a file in a specific leaf in a given window. If windowId or leafId is not specified
   * it will open the file in the last focused leaf, in the last focused window.
   *
   * @param  {string|undefined} windowId  The windowId to open the document in
   * @param  {string|undefined} leafId    The leafId of the window to open the document in
   * @param  {string}  filePath   The absolute file path
   * @param  {boolean} newTab Optional. If true, will always prevent exchanging the currently active file.
   *
   * @return {Promise<boolean>} True if it successfully opens the file
   */
  public async openFile(
    windowId: string | undefined,
    leafId: string | undefined,
    filePath: string,
    newTab?: boolean,
    navigation?: {
      targetRange?: SourceRange;
      sourceLocation?: DocumentLocation;
    },
  ): Promise<boolean> {
    if (!isFile(filePath)) {
      // The renderer process essentially just throws paths at the documents
      // provider when the user intents to open them. Users can also link
      // folders, so we just quickly check for that, and open them (similar to
      // non-Markdown files a few lines below).
      if (isDir(filePath)) {
        await shell.openPath(filePath);
        return false;
      }

      // Else: Whatever this is, it was not a proper path.
      throw new Error(`Could not open file ${filePath}: Not an existing file.`);
    }

    // Check if we can, and should, actually open the file in Zettlr. If not, we
    // need to open it via the shell externally. NOTE: This check is, to varying
    // degrees, implemented at the sources of opening-requests (read: mostly in
    // the renderers). If you see this comment, and spot a place where we
    // implemented this guard somewhere else, please refactor to simply attempt
    // to open a file path with the documents provider and defer to this check
    // here. Amend with any additional necessary checks from the other guards.
    if (!hasMdOrCodeExt(filePath)) {
      const { files } = this._app.config.get();
      let shouldOpenExternally = true;
      if (hasImageExt(filePath) && files.images.openWith === "zettlr") {
        shouldOpenExternally = false;
      } else if (hasPDFExt(filePath) && files.pdf.openWith === "zettlr") {
        shouldOpenExternally = false;
      }

      if (shouldOpenExternally) {
        await shell.openPath(filePath);
        return false;
      }
    }

    // If windowId is not provided, then use the last focused window
    if (windowId === undefined) {
      const mainWindow: BrowserWindow | undefined = this._app.windows.getFirstMainWindow();
      const key =
        mainWindow !== undefined ? this._app.windows.getMainWindowKey(mainWindow) : undefined;
      if (key !== undefined) {
        windowId = key;
      }
    }

    if (windowId === undefined) {
      this._app.log.warning(`Could not open file ${filePath}: windowId was undefined.`);
      return false;
    }

    let leaf: DTLeaf | undefined;
    if (leafId === undefined) {
      if (this._lastEditor.leafId !== undefined) {
        leaf = this._windows[windowId].findLeaf(this._lastEditor.leafId);
      }
      if (leaf === undefined) {
        leaf = this._windows[windowId].getAllLeafs()[0];
      }
    } else {
      leaf = this._windows[windowId].findLeaf(leafId);
    }

    if (leaf === undefined) {
      this._app.log.warning(`Could not open file ${filePath}: leaf was undefined.`);
      return false;
    }

    // Now we definitely know the leaf ID if it was undefined
    if (leafId === undefined) {
      leafId = leaf.id;
    }

    this._updateFocusLeaf(windowId, leafId);

    // Issue #1 Phase 5: a reference jump carries the origin location captured
    // at jump time. Stamp it onto the pane's current history entry (which
    // corresponds to the currently active file) so Back can restore it.
    const sourceLocation = navigation?.sourceLocation;
    if (
      sourceLocation !== undefined &&
      leaf.tabMan.activeFile?.path === sourceLocation.documentPath
    ) {
      leaf.tabMan.updateCurrentHistoryLocation(sourceLocation);
    }

    // After here, the document will in some way be opened.
    this._app.recentDocs.add(filePath);

    const { openFiles, openWorkspaces } = this._app.config.get().app;
    if (!openFiles.includes(filePath) && openWorkspaces.every((p) => !filePath.startsWith(p))) {
      // The file just opened is outside the current opened roots -> add as a
      // standalone root file.
      this._app.config.addPath(filePath);
    }

    if (leaf.tabMan.openFiles.map((x) => x.path).includes(filePath)) {
      // File is already open -> simply set it as active
      // leaf.tabMan.activeFile = filePath
      leaf.tabMan.openFile(filePath);
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId,
        leafId,
        filePath,
        targetRange: navigation?.targetRange,
      });
      this.syncToConfig();
      return true;
    }

    // NOTE: Since openFile will set filePath as active, we have to retrieve the
    // (previously) active file *before* opening the new one. See bug #5065 for
    // context.
    const activeFile = leaf.tabMan.activeFile;
    const ret = leaf.tabMan.openFile(filePath);
    if (ret) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId, filePath });
    }

    // Close the (formerly active) file if we should avoid new tabs and have not
    // gotten a specific request to open it in a *new* tab
    const { avoidNewTabs } = this._app.config.get().system;
    if (
      activeFile !== null &&
      avoidNewTabs &&
      newTab !== true &&
      !this.isModified(activeFile.path)
    ) {
      leaf.tabMan.closeFile(activeFile);
      this.syncWatchedFilePaths();
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
        windowId,
        leafId,
        filePath: activeFile.path,
      });
    }

    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: leaf.tabMan.activeFile?.path,
      targetRange: navigation?.targetRange,
    });
    await this.synchronizeDatabases();
    this.syncToConfig();
    return ret;
  }

  /**
   * Closes the given file if it's in fact open. This function deals with every
   * potential problem such as retrieving user consent to closing the file if it
   * is modified.
   *
   * @param   {MDFileDescriptor|CodeFileDescriptor}  file  The file to be closed
   *
   * @return  {boolean}                                    Whether or not the file was closed
   */
  public async closeFile(windowId: string, leafId: string, filePath: string): Promise<boolean> {
    const leaf = this._windows[windowId].findLeaf(leafId);
    if (leaf === undefined) {
      this._app.log.error(
        `[Document Manager] Could not close file ${filePath}: Editor pane not found.`,
      );
      return false;
    }

    let numOpenInstances = 0;
    await this.forEachLeaf(async (tabMan) => {
      const file = tabMan.openFiles.find((f) => f.path === filePath);
      if (file !== undefined) {
        numOpenInstances++;
      }
      return false;
    });

    // If we were to completely remove the file from our buffer, we have to ask
    // first. If there's at least another instance open that means that we won't
    // lose the file. NOTE: openFile will be undefined if the file has not been
    // opened in this session of Zettlr, hence it will not be modified, hence we
    // don't have to do anything.
    const openFile = this.documents.find((doc) => doc.filePath === filePath);
    if (openFile !== undefined && this.isModified(filePath) && numOpenInstances === 1) {
      const detail = trans("File: %s", openFile.descriptor.name);
      const result = await this._app.windows.askSaveChanges(detail);
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 1) {
        // Clear the modification flag
        openFile.lastSavedVersion = openFile.currentVersion;
        {
          const _id = this.getDocumentId(filePath);
          if (_id !== undefined) {
            this._closeReview(_id);
          }
        }
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
          filePath,
          status: "modification",
        });
      } else if (result.response === 0) {
        const saved = await this.saveFile(filePath);
        if (!saved.ok) {
          this._announceSaveRefusal(filePath, saved);
          return false;
        }
      } else {
        // Don't close the file
        this._app.log.info("[Document Manager] Not closing file, as the user did not want that.");
        return false;
      }

      // Remove the file
      this.documents.splice(this.documents.indexOf(openFile), 1);
    } else if (openFile !== undefined && numOpenInstances === 1) {
      // The file is not modified, but this is still the last instance, so we
      // can close it without having to ask.
      this.documents.splice(this.documents.indexOf(openFile), 1);
      {
        const _id = this.getDocumentId(filePath);
        if (_id !== undefined) {
          this._closeReview(_id);
        }
      }
    }

    const ret = leaf.tabMan.closeFile(filePath);
    if (ret) {
      this.syncToConfig();
      this.syncWatchedFilePaths();
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath });
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId,
        leafId,
        filePath: leaf.tabMan.activeFile?.path,
      });
      if (leaf.tabMan.openFiles.length === 0) {
        // Remove this leaf
        leaf.parent.removeNode(leaf);
        this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId });
        this.syncToConfig();
      }

      await this.synchronizeDatabases();
    }
    return ret;
  }

  /**
   * Directs every open leaf to close a given file. This function even
   * overwrites potential stati such as modification or pinned to ensure files
   * are definitely closed. This will be called from within the watcher callback
   * on an `unlink` event.
   *
   * @param   {string}  filePath  The file path in question
   */
  public async closeFileEverywhere(filePath: string): Promise<void> {
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      if (tabMan.openFiles.map((x) => x.path).includes(filePath)) {
        tabMan.setPinnedStatus(filePath, false);
        const success = tabMan.closeFile(filePath);

        if (!success) {
          return false;
        }

        this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
          windowId,
          leafId,
          filePath,
        });

        if (tabMan.openFiles.length === 0) {
          this.closeLeaf(windowId, leafId);
        }
      }

      return true;
    });

    // We also must splice the document out of our provider
    const documentId = this.getDocumentId(filePath);
    const idx = this.documents.findIndex((doc) => doc.filePath === filePath);
    if (idx > -1) {
      this.documents.splice(idx, 1);
    }
    if (documentId !== undefined) {
      this._closeReview(documentId);
    }

    this.syncWatchedFilePaths();
  }

  /**
   * For the provided root workspace directory at `filePath`,
   * retrieve a list of filepaths representing every open file
   * within the workspace.
   *
   * @param {string}      filePath  Path of the workspace directory
   *
   * @returns {string[]}            A list of file paths representing the
   *                                open files within `filePath`.
   */
  /**
   * For the provided root workspace directory at `workspacePath`,
   * retrieve a list of filepaths representing every supported file
   * within the workspace, using FSAL as the source of truth.
   */
  public async getFilesForWorkspace(workspacePath: string): Promise<string[]> {
    const allPaths = await this._app.fsal.readDirectoryRecursively(workspacePath);
    // Filter: supported file extensions, and exclude the workspace directory itself
    return allPaths.filter((p) => p !== workspacePath && hasMdOrCodeExt(p) && !isDir(p));
  }

  /**
   * This function handles a remote change, i.e. where the watcher has reported
   * that the file has been changed remotely.
   *
   * @param   {string}  filePath  The file in question
   */
  private async handleRemoteChange(filePath: string): Promise<void> {
    // First thing we have to look up is: Did the file really change? Then, we
    // have to update the file descriptors across all leafs and broadcast an event.
    const openFiles: OpenDocument[] = [];
    for (const key in this._windows) {
      const allLeafs = this._windows[key].getAllLeafs();
      for (const leaf of allLeafs) {
        openFiles.push(...leaf.tabMan.openFiles.filter((x) => x.path === filePath));
      }
    }

    const doc = this.documents.find((doc) => doc.filePath === filePath);

    if (doc === undefined) {
      throw new Error(
        `Could not handle remote change for file ${filePath}: Could not find corresponding file!`,
      );
    }

    const metadata = await this._app.fsal.getFilesystemMetadata(filePath);
    const modtime = metadata.modtime;
    const ourModtime = doc.descriptor.modtime;

    // In response to issue #1621: We will not check for equal modtime but only
    // for newer modtime to prevent sluggish cloud synchronization services
    // (e.g. OneDrive and Box) from having text appear to "jump" from time to time.
    if (modtime <= ourModtime) {
      return; // Nothing to do
    }

    // ... however, some cloud services may still emit additional change events
    // that merely change attributes, but not the content. We handle this case
    // next
    const diskContents = await this._app.fsal.loadAnySupportedFile(doc.descriptor.path);

    if (diskContents === doc.lastSavedContent) {
      return;
    }

    // Spec section 10: if there is an active review for this document,
    // invalidate it before proceeding with external-change resolution.
    // The review rejects further proposals; both the live editor content
    // and external disk content are preserved; the existing external-change
    // resolution dialog proceeds as normal.
    const _docId = this.getDocumentId(filePath);
    if (_docId !== undefined) {
      const _review = this._reviewStore.getReview(_docId);
      if (_review !== undefined && !_review.invalidated) {
        this._reviewStore.invalidateReview(_docId);
        this._broadcastReviewCleared(filePath, _review.reviewId);
      }
    }

    const isModified = doc.lastSavedVersion !== doc.currentVersion;
    const { alwaysReloadFiles } = this._app.config.get();
    if (isModified || !alwaysReloadFiles) {
      // The file is modified in buffer, or the user does not want to simply
      // reload changes, so we cannot just overwrite anything
      // Prevent multiple instances of the dialog, just ask once. The logic
      // always retrieves the most recent version either way
      if (this._remoteChangeDialogShownFor.includes(filePath)) {
        return;
      }

      this._remoteChangeDialogShownFor.push(filePath);
      const filename = doc.descriptor.name;

      // Ask the user if we should replace the file
      const response = await dialog.showMessageBox({
        title: trans("File changed on disk"),
        message: trans("%s changed on disk", filename),
        detail: isModified
          ? trans(
              "%s has changed on disk, but the editor contains unsaved changes. Do you want to keep the current editor contents or load the file from disk?",
              filename,
            )
          : trans("Do you want to keep the current editor contents or load the file from disk?"),
        type: "question",
        buttons: [trans("Keep editor contents"), trans("Load changes from disk")],
        defaultId: 0,
        checkboxLabel: trans(
          "Always load changes from disk if there are no unsaved changes in the editor",
        ),
        checkboxChecked: alwaysReloadFiles,
      });

      this._remoteChangeDialogShownFor.splice(
        this._remoteChangeDialogShownFor.indexOf(filePath),
        1,
      );

      this._app.config.set("alwaysReloadFiles", response.checkboxChecked);

      if (response.response === 0) {
        // User does not want to load the disk contents. To ensure that the
        // proper status is indicated, set the "lastSavedVersion" to one minus.
        doc.lastSavedVersion--;
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
          filePath,
          status: "modification",
        });
      } else {
        await this.notifyRemoteChange(filePath);
      }
    } else {
      // The user has activated the setting to alwaysReloadFiles.
      await this.notifyRemoteChange(filePath);
    }
  }

  /**
   * This function can be called from within the FSAL or programmatically, if a
   * file has been programmatically been moved (either by renaming or moving).
   * This makes it easier for the user to not even notice this inside the open
   * documents.
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The path it'll be afterwards
   */
  public async hasMovedFile(oldPath: string, newPath: string): Promise<void> {
    // Basically we just have to close the oldPath, and "open" the new path.
    const openDoc = this.documents.find((doc) => doc.filePath === oldPath);
    if (openDoc === undefined) {
      return; // Nothing to do
    }

    openDoc.filePath = newPath;
    openDoc.descriptor.path = newPath;
    openDoc.descriptor.dir = path.dirname(newPath);
    openDoc.descriptor.name = path.basename(newPath);
    openDoc.descriptor.ext = path.extname(newPath);

    const leafsToNotify: Array<[string, string]> = [];
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      const res = tabMan.replaceFilePath(oldPath, newPath);
      if (res) {
        leafsToNotify.push([windowId, leafId]);
      }
      return res;
    });

    this.syncWatchedFilePaths();

    // Emit the necessary events to each window
    for (const [windowId, leafId] of leafsToNotify) {
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
        filePath: oldPath,
        windowId,
        leafId,
      });
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, {
        filePath: newPath,
        windowId,
        leafId,
      });
      // Ensure the renderer picks up the correct (new) active file path, if
      // that has changed (noop in othe cases; see #5574).
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId });
    }
  }

  /**
   * Convenience function, can be called in case of moving a directory around.
   * Will internally call hasMovedFile for every affected file to ensure a
   * smooth user experience.
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The new path
   */
  public async hasMovedDir(oldPath: string, newPath: string): Promise<void> {
    // Similar as hasMovedFile, but triggers the command for every affected file
    const docs = this.documents.filter((doc) => doc.filePath.startsWith(oldPath));

    for (const doc of docs) {
      this._app.log.info(
        "Replacing file path for doc " +
          doc.filePath +
          " with " +
          doc.filePath.replace(oldPath, newPath),
      );
      await this.hasMovedFile(doc.filePath, doc.filePath.replace(oldPath, newPath));
    }
  }

  /**
   * This function ensures that our watcher keeps watching the correct files
   */
  private syncWatchedFilePaths(): void {
    // First, get the files currently watched
    const watchedFiles: string[] = [];
    const watched = this._watcher.getWatched();
    for (const dir in watched) {
      for (const filename of watched[dir]) {
        watchedFiles.push(path.join(dir, filename));
      }
    }

    // Second, get all open files. NOTE: This does not mean "open open", but
    // rather paths that are "open" somewhere in a leaf. Not actively viewed.
    let openFiles: string[] = [];
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        openFiles.push(...leaf.tabMan.openFiles.map((f) => f.path));
      }
    }

    openFiles = [...new Set(openFiles)]; // Remove duplicates

    // Third, remove those watched files which are no longer open
    for (const watchedFile of watchedFiles) {
      if (!openFiles.includes(watchedFile)) {
        this._watcher.unwatchPath(watchedFile);
      }
    }

    // Fourth, add those open files not yet watched
    for (const openFile of openFiles) {
      if (!watchedFiles.includes(openFile)) {
        this._watcher.watchPath(openFile);
      }
    }
  }

  /**
   * This is a convenience function meant for operations that affect every
   * editor pane across the whole application, such as renaming files, removing
   * directories, and other things. It will iterate over every open editor pane
   * and call the provided callback function, providing the tab manager for the
   * pane in question. Since some operations require async, the whole function
   * works asynchronously.
   *
   * The callback function MUST return a boolean indicating whether the state of
   * any pane has changed. If it has, the function will make sure to emit
   * appropriate events. If you do not honor this, any changes to the internal
   * state will not be picked up by the appropriate places.
   *
   * @param   {(tabMan: TabManager) => Promise<boolean>}  callback  The callback
   */
  public async forEachLeaf(
    callback: (tabMan: TabManager, windowId: string, leafId: string) => Promise<boolean>,
  ): Promise<void> {
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        const stateHasChanged = await callback(leaf.tabMan, windowId, leaf.id);
        if (stateHasChanged) {
          this.syncToConfig();
        }
      }
    }
  }

  /**
   * This method synchronizes the state of the loadedDocuments array into the
   * configuration. It also makes sure to announce changes to whomever it may
   * concern.
   */
  private syncToConfig(): void {
    const toSave: DocumentWindowsJSON = {};
    for (const key in this._windows) {
      toSave[key] = this._windows[key].toJSON();
    }
    this._config.set(toSave);
  }

  /**
   * Sets the pinned status for the given file.
   *
   * @param   {string}   filePath        The absolute path to the file
   * @param   {boolean}  shouldBePinned  Whether the file should be pinned.
   */
  private setPinnedStatus(
    windowId: string,
    leafId: string,
    filePath: string,
    shouldBePinned: boolean,
  ): void {
    const leaf = this._windows[windowId].findLeaf(leafId);
    if (leaf === undefined) {
      return;
    }

    leaf.tabMan.setPinnedStatus(filePath, shouldBePinned);
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      windowId,
      leafId,
      filePath,
      status: "pinned",
    });
    this.syncToConfig();
  }

  /**
   * Broadcasts a remote changed event across the app to notify everyone that a
   * file has been remotely changed.
   *
   * @param {string} filePath The file in question
   */
  public async notifyRemoteChange(filePath: string): Promise<void> {
    // Here we basically only need to close the document and wait for the
    // renderers to reload themselves with getDocument, which will automatically
    // open the new document.
    const idx = this.documents.findIndex((file) => file.filePath === filePath);
    this.documents.splice(idx, 1);
    {
      const _id = this.getDocumentId(filePath);
      if (_id !== undefined) {
        this._closeReview(_id);
      }
    }
    // Indicate to all affected editors that they should reload the file
    this.broadcastEvent(DP_EVENTS.FILE_REMOTELY_CHANGED, { filePath });
  }

  public sortOpenFiles(windowId: string, leafId: string, newOrder: string[]): void {
    const leaf = this._windows[windowId].findLeaf(leafId);
    if (leaf === undefined) {
      return;
    }

    const res = leaf.tabMan.sortOpenFiles(newOrder);
    if (res) {
      this.broadcastEvent(DP_EVENTS.FILES_SORTED, { windowId, leafId });
      this.syncToConfig();
    }
  }

  /**
   * Using this function, one can move a given file from one editor pane to
   * another -- even across windows.
   *
   * @param {number} originWindow The originating window
   * @param {number} targetWindow The target window
   * @param {string} originLeaf   The origin pane in the origin window
   * @param {string} targetLeaf   The target pane in the target window
   * @param {string} filePath     The file to be moved
   */
  public async moveFile(
    originWindow: string,
    targetWindow: string,
    originLeaf: string,
    targetLeaf: string,
    filePath: string,
  ): Promise<void> {
    // The user has requested to move a file. This basically just means closing
    // the file in the origin, and opening it in the target
    const origin = this._windows[originWindow].findLeaf(originLeaf);
    const target = this._windows[targetWindow].findLeaf(targetLeaf);

    if (origin === undefined || target === undefined) {
      this._app.log.error(
        `[Document Manager] Received a move request from ${originLeaf} to ${targetLeaf} but one of those was undefined.`,
      );
      return;
    }

    // First open the file in the target
    let success = target.tabMan.openFile(filePath);
    if (success) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, {
        windowId: targetWindow,
        leafId: targetLeaf,
        filePath,
      });
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId: targetWindow,
        leafId: targetLeaf,
      });
      this.syncToConfig();
    }

    // Then decide if we should close the leaf ...
    if (origin.tabMan.openFiles.length === 1) {
      // Close the leaf instead
      this.closeLeaf(originWindow, originLeaf);
      this.syncToConfig();
    } else {
      // ... or rather just close the file
      success = origin.tabMan.closeFile(filePath);
      if (!success) {
        this._app.log.error(
          `[Document Manager] Could not fulfill move request for file ${filePath}: Could not close it.`,
        );
        return;
      }

      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
        windowId: originWindow,
        leafId: originLeaf,
        filePath,
      });
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId: originWindow,
        leafId: originLeaf,
      });
      this.syncToConfig();
    }
  }

  /**
   * Splits the given origin leaf along the direction. Optionally, you can also
   * direct the document manager to immediately move a file from the origin to
   * the to-be-created leaf to fill it with content.
   *
   * @param {number} originWindow   The originating window
   * @param {string} originLeaf     The origin pane in the origin window
   * @param {string} splitDirection The direction of the split (horizontal or vertical)
   * @param {string} insertion      Where to insert the new leaf (defaults to after)
   * @param {string} filePath       Optional: the file to be moved
   * @param {number} fromWindow     Optional: If the file doesn't come from origin
   * @param {string} fromLeaf       Optional: If the file doesn't come from origin
   */
  public async splitLeaf(
    originWindow: string,
    originLeaf: string,
    splitDirection: "horizontal" | "vertical",
    insertion: "before" | "after" = "after",
    filePath?: string,
    fromWindow?: string,
    fromLeaf?: string,
  ): Promise<void> {
    // The user has requested a split and following move of a file
    const origin = this._windows[originWindow].findLeaf(originLeaf);

    if (origin === undefined) {
      this._app.log.error(
        `[Document Manager] Received a split request from ${originLeaf} but could not find it.`,
      );
      return;
    }

    const target = origin.split(splitDirection, insertion);
    this.broadcastEvent(DP_EVENTS.NEW_LEAF, {
      windowId: originWindow,
      originLeaf,
      newLeaf: target.id,
      direction: splitDirection,
      insertion,
    });

    this.syncToConfig();

    if (filePath !== undefined) {
      const win = fromWindow ?? originWindow;
      const leaf = fromLeaf ?? originLeaf;
      await this.moveFile(win, originWindow, leaf, target.id, filePath);
    }
  }

  public closeLeaf(windowId: string, leafId: string): void {
    const leaf = this._windows[windowId].findLeaf(leafId);

    if (leaf !== undefined) {
      leaf.parent.removeNode(leaf);
      this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId });
      this._updateFocusLeaf(windowId, this._windows[windowId].getAllLeafs()[0].id);
    }
  }

  /**
   * Returns the hash of the currently active file.
   * @returns {number|null} The hash of the active file.
   */
  public getActiveFile(leafId: string): string | null {
    for (const windowId in this._windows) {
      const leaf = this._windows[windowId].findLeaf(leafId);
      if (leaf !== undefined) {
        return leaf.tabMan.activeFile?.path ?? null;
      }
    }
    return null;
  }

  public isModified(filePath: string): boolean {
    const doc = this.documents.find((doc) => doc.filePath === filePath);
    if (doc !== undefined) {
      return doc.currentVersion !== doc.lastSavedVersion;
    } else {
      return false; // None existing files aren't modified
    }
  }

  /**
   * Returns true if none of the open files have their modified flag set.
   *
   * @param  {string|number}  leafId  Can either contain a leafId or a window
   *                                  index, and returns the clean state only
   *                                  for that. If undefined, returns the total
   *                                  clean state.
   */
  public isClean(id?: string, which?: "window" | "leaf"): boolean {
    const modPaths = this.documents
      .filter((x) => this.isModified(x.filePath))
      .map((x) => x.filePath);

    if (id === undefined) {
      // Total clean state
      return modPaths.length === 0;
    } else if (which === "window") {
      // window-specific clean state
      const allLeafs = this._windows[id].getAllLeafs();
      for (const leaf of allLeafs) {
        for (const file of leaf.tabMan.openFiles) {
          if (modPaths.includes(file.path)) {
            return false;
          }
        }
      }
    } else {
      // leaf-specific clean state
      for (const key in this._windows) {
        const leaf = this._windows[key].findLeaf(id);
        if (leaf !== undefined) {
          for (const file of leaf.tabMan.openFiles) {
            if (modPaths.includes(file.path)) {
              return false;
            }
          }
        }
      }
    }

    return true;
  }

  public async navigateForward(
    windowId: string,
    leafId: string,
    location?: DocumentLocation,
  ): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId);
    if (leaf === undefined) {
      return;
    }

    this._stampCurrentHistoryLocation(leaf.tabMan, location);
    const entry = leaf.tabMan.forward();
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId });
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: entry?.path,
      location: entry?.location,
    });
  }

  public async navigateBack(
    windowId: string,
    leafId: string,
    location?: DocumentLocation,
  ): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId);
    if (leaf === undefined) {
      return;
    }

    this._stampCurrentHistoryLocation(leaf.tabMan, location);
    const entry = leaf.tabMan.back();
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId });
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: entry?.path,
      location: entry?.location,
    });
  }

  /**
   * Stamps the given location onto the tab manager's current history entry
   * (issue #1 Phase 5) when it belongs to the currently active file, so the
   * opposite navigation direction can restore the exact selection, viewport
   * scroll, and folds.
   *
   * @param   {TabManager}        tabMan    The pane's tab manager
   * @param   {DocumentLocation}  location  The location sent by the renderer
   */
  private _stampCurrentHistoryLocation(tabMan: TabManager, location?: DocumentLocation): void {
    if (location !== undefined && tabMan.activeFile?.path === location.documentPath) {
      tabMan.updateCurrentHistoryLocation(location);
    }
  }

  /**
   * Returns whether the given leaf can navigate back/forward through its
   * session history (issue #1 Phase 5; feeds the toolbar Back/Forward
   * enabled state).
   *
   * @param   {string}  windowId  The window ID
   * @param   {string}  leafId    The leaf ID
   *
   * @return  {{ canGoBack: boolean, canGoForward: boolean }}  The state
   */
  public getNavigationState(
    windowId: string,
    leafId: string,
  ): { canGoBack: boolean; canGoForward: boolean } {
    const leaf = windowId in this._windows ? this._windows[windowId].findLeaf(leafId) : undefined;
    if (leaf === undefined) {
      return { canGoBack: false, canGoForward: false };
    }

    return {
      canGoBack: leaf.tabMan.canGoBack,
      canGoForward: leaf.tabMan.canGoForward,
    };
  }

  /**
   * Reconciles a pane's accept/reject report into the provider-owned review
   * state. Every rejection path logs why: a refused report leaves the review's
   * unresolved count unchanged, which closes the save gate, and without a
   * reason the resulting deadlock is invisible in the logs.
   */
  private setReviewDiffStatus(status: ReviewDiffStatus): boolean {
    const docId = this.getDocumentId(status.filePath);
    if (docId === undefined) {
      this._app.log.error(
        `[DocumentManager] Review status refused: no documentId for ${status.filePath}`,
      );
      return false;
    }
    const review = this._reviewStore.getReview(docId);
    if (review === undefined) {
      this._app.log.error(
        `[DocumentManager] Review status refused: no active review for ${status.filePath}`,
      );
      return false;
    }
    if (review.reviewId !== status.sessionId) {
      this._app.log.error(
        `[DocumentManager] Review status refused: session ${status.sessionId} does not match ` +
          `active review ${review.reviewId} for ${status.filePath}`,
      );
      return false;
    }

    // Spec section 13: guard against stale pane decisions by checking
    // the review generation the pane observed when reporting.
    if (status.reviewGeneration !== review.generation) {
      // The pane's report is stale — re-broadcast the current state so the
      // pane can update its merge reference.
      this._app.log.warning(
        `[DocumentManager] Review status stale: pane reported generation ` +
          `${status.reviewGeneration}, provider is at ${review.generation}; re-broadcasting`,
      );
      this._broadcastReviewState(status.filePath, review);
      return false;
    }

    const document = this.documents.find((doc) => doc.filePath === status.filePath);
    if (document === undefined) {
      this._app.log.error(
        `[DocumentManager] Review status refused: ${status.filePath} is not an open document`,
      );
      return false;
    }
    if (document.currentVersion !== status.documentVersion) {
      this._app.log.warning(
        `[DocumentManager] Review status refused: pane reported document version ` +
          `${status.documentVersion}, provider is at ${document.currentVersion}; re-broadcasting`,
      );
      this._broadcastReviewState(status.filePath, review);
      return false;
    }
    if (document.document.toString() !== status.currentText) {
      this._app.log.warning(
        "[DocumentManager] Review status refused: pane text does not match the provider buffer " +
          `for ${status.filePath}; re-broadcasting`,
      );
      this._broadcastReviewState(status.filePath, review);
      return false;
    }

    // Reconcile: the renderer reports the current originalText (merge reference)
    // and currentText (working). Update the store's referenceText to match the
    // renderer's evolved merge reference — this is the provider-owned state
    // synchronization point (spec section 7).
    const changed =
      review.referenceText !== status.originalText || review.workingText !== status.currentText;
    if (changed) {
      review.referenceText = status.originalText;
      review.workingText = status.currentText;
      review.generation += 1;
      const unresolvedChunks = this._reviewStore.countUnresolvedChunks(review);
      this._reviewStore.emitEvent("review.changed", {
        reviewId: review.reviewId,
        documentId: docId,
        generation: review.generation,
        unresolvedChunks,
      });
      if (unresolvedChunks === 0) {
        this._reviewStore.emitEvent("review.resolved", {
          reviewId: review.reviewId,
          documentId: docId,
          generation: review.generation,
        });
      }
    }
    this._broadcastReviewState(status.filePath, review);
    return true;
  }

  /**
   * Returns the reason a review blocks saving `filePath`, or undefined when the
   * save may proceed. Presentation is the renderer's job — see SaveRefusal.
   */
  private async checkReviewDiffSaveGate(
    filePath: string,
  ): Promise<SaveRefusal | undefined> {
    const docId = this.getDocumentId(filePath);
    if (docId === undefined) {
      return undefined;
    }
    const review = this._reviewStore.getReview(docId);
    if (review === undefined) {
      return undefined;
    }

    const status = this._reviewStore.getReviewStatus(docId);
    // The gate closes for distinct reasons and the user needs to know which:
    // unresolved chunks are their own to resolve, but a missing report or a
    // reference/working divergence means the provider never received a pane
    // decision — the user can accept every chunk in the editor and still be
    // refused. A missing status is not zero chunks and not an unknown count of
    // them; it is a review the pane has never reported on at all.
    if (status === undefined) {
      this._app.log.error(
        `[DocumentManager] Save gate closed for ${filePath}: the review store holds ` +
          `review generation ${review.generation} but no status for document ${docId}, ` +
          "so the pane has never reported on it. Expect a missing or failed " +
          "setReviewDiffStatus round trip.",
      );
      return {
        reason: "review-out-of-sync",
        message: trans(
          "This review is out of sync with the editor and cannot be saved. See the log for the reason.",
        ),
      };
    }
    if (status.unresolvedChunks > 0) {
      this._app.log.warning(
        `[DocumentManager] Save gate closed for ${filePath}: ` +
          `${status.unresolvedChunks} unresolved chunk(s) at generation ` +
          `${review.generation}`,
      );
      return {
        reason: "unresolved-chunks",
        message: trans(
          "Resolve every accept/reject chunk before saving this review.",
        ),
      };
    }
    if (review.referenceText !== review.workingText) {
      this._app.log.error(
        `[DocumentManager] Save gate closed for ${filePath}: no unresolved chunks, but the ` +
          `review reference and working text still differ at generation ${review.generation}. ` +
          "The pane's accept/reject report never reached the provider — see the refusal reason " +
          "logged by setReviewDiffStatus.",
      );
      return {
        reason: "review-out-of-sync",
        message: trans(
          "This review is out of sync with the editor and cannot be saved. See the log for the reason.",
        ),
      };
    }

    const diskContents = await this._app.fsal.loadAnySupportedFile(filePath);
    if (sha256Text(normalizeText(diskContents)) !== review.diskFenceSha256) {
      this._app.log.warning(
        `[DocumentManager] Save gate closed for ${filePath}: the document changed on disk ` +
          "after the review opened; the external edit was preserved.",
      );
      return {
        reason: "disk-changed",
        message: trans(
          "The document changed on disk after this review opened. The external edit was preserved.",
        ),
      };
    }

    return undefined;
  }

  public async saveFile(filePath: string): Promise<SaveFileResult> {
    const doc = this.documents.find((doc) => doc.filePath === filePath);

    if (doc === undefined) {
      this._app.log.error(
        `[Document Provider] Could not save file ${filePath}: Not found in loaded documents!`,
      );
      return { ok: false };
    }

    // If saveFile was called from a timeout, clearTimeout does nothing but the
    // timeout is reset to undefined. However, implementing this check here
    // ensures that we can programmatically call saveFile anywhere else and
    // still have everything work as intended.
    if (doc.saveTimeout !== undefined) {
      clearTimeout(doc.saveTimeout);
      doc.saveTimeout = undefined;
    }

    const refusal = await this.checkReviewDiffSaveGate(filePath);
    if (refusal !== undefined) {
      return { ok: false, refusal };
    }

    // NOTE: Remember that we MUST under any circumstances adapt the document
    // descriptor BEFORE attempting to save. The reason is that if we don't do
    // that, we can run into the following race condition:
    // 1. User changes the document
    // 2. The save commences
    // 3. The user adds more changes
    // 4. The save finishes and undos the modifications

    // NOTE: Zettlr internally always uses regular LF linefeeds. The FSAL load
    // and FSAL save methods will take care to actually use the proper linefeeds
    // and BOMs. So here we will always use newlines. This should fix and in the
    // future prevent bugs like #4959
    const docLines = [...doc.document.iterLines()];
    const content = docLines.join("\n");
    doc.lastSavedVersion = doc.currentVersion;
    doc.lastSavedContent = content;

    if (doc.descriptor.type === "file") {
      // In case of an MD File increase the word or char count
      const locale: string = this._app.config.get().appLang;
      const ast = markdownToAST(content);
      const counts = countAll(ast, locale);
      const newWordCount = counts.words;
      const newCharCount = counts.chars;

      this._app.stats.updateCounts(
        newWordCount - doc.lastSavedWordCount,
        newCharCount - doc.lastSavedCharCount,
      );

      doc.lastSavedWordCount = newWordCount;
      doc.lastSavedCharCount = newCharCount;
    }

    this._ignoreChanges.push(filePath);

    try {
      if (doc.descriptor.type === "file") {
        const fileContents = doc.descriptor.bom + content.split("\n").join(doc.descriptor.linefeed);
        await this._app.fsal.writeTextFile(doc.descriptor.path, fileContents);
        doc.descriptor = (await this._app.fsal.getDescriptorFor(
          doc.descriptor.path,
          false,
        )) as MDFileDescriptor;
        await this.synchronizeDatabases(); // The file may have gotten a library
      } else {
        await this._app.fsal.writeTextFile(doc.descriptor.path, content);
        doc.descriptor = (await this._app.fsal.getDescriptorFor(
          doc.descriptor.path,
          false,
        )) as CodeFileDescriptor;
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        dialog.showErrorBox(
          trans("Could not save file"),
          trans("Could not save file %s: %s", doc.descriptor.name, err.message),
        );
      }

      throw err;
    }

    this._app.log.info(`[DocumentManager] File ${filePath} saved.`);
    {
      const _id = this.getDocumentId(filePath);
      if (_id !== undefined) {
        const _review = this._reviewStore.getReview(_id);
        if (_review !== undefined) {
          this._broadcastReviewCleared(filePath, _review.reviewId);
        }
        this._reviewStore.completeReview(_id);
        this._clearProposalIdempotency(_id);
      }
    }
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      filePath,
      status: "modification",
    });
    this.broadcastEvent(DP_EVENTS.FILE_SAVED, { filePath });

    return { ok: true };
  }

  private _updateFocusLeaf(windowId: string, leafId: string): void {
    this._lastEditor.windowId = windowId;
    this._lastEditor.leafId = leafId;
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: this.getActiveFile(leafId) ?? undefined,
    });
  }

  // ==========================================================================
  // Agent API: documentId, focused-view, snapshot tokens, proposal submission
  // (spec sections 4-7, 10)
  // ==========================================================================

  /**
   * Get or assign the opaque documentId for a loaded document path.
   * The documentId is stable for the lifetime of a loaded document.
   */
  public getDocumentId(filePath: string): string | undefined {
    return this._documentIdByPath.get(filePath);
  }

  public ensureDocumentId(filePath: string): string {
    return this._assignDocumentId(filePath);
  }

  /**
   * Makes a refused save visible when main, not the editor, asked for it.
   *
   * The close-and-save prompts run here and abort the close on a refusal. The
   * gate deliberately no longer presents its own dialog (a blocking modal in
   * main is what made the original deadlock unrecoverable), and the renderer
   * only surfaces refusals for saves it requested itself — so without this the
   * prompt closes, the window stays open, and the reason is only in the log.
   */
  private _announceSaveRefusal(filePath: string, result: SaveFileResult): void {
    if (result.ok) {
      return;
    }
    this._app.log.warning(
      `[DocumentManager] Close aborted: ${filePath} could not be saved` +
        (result.refusal === undefined
          ? " and reported no reason."
          : ` (${result.refusal.reason}): ${result.refusal.message}`),
    );
    const payload: SaveRefusedBroadcast = {
      filePath,
      refusal: result.refusal,
    };
    broadcastIpcMessage(SAVE_REFUSED_CHANNEL, payload);
  }

  private _closeReview(documentId: string): void {
    this._reviewStore.closeReview(documentId);
    this._clearProposalIdempotency(documentId);
  }

  private _clearProposalIdempotency(documentId: string): void {
    const prefix = `${documentId}:`;
    for (const key of this._proposalIdempotency.keys()) {
      if (key.startsWith(prefix)) {
        this._proposalIdempotency.delete(key);
      }
    }
  }

  /**
   * Get the file path for a documentId.
   */
  public getDocumentPath(documentId: string): string | undefined {
    for (const [filePath, id] of this._documentIdByPath) {
      if (id === documentId) {
        return filePath;
      }
    }
    return undefined;
  }

  /**
   * Assign a documentId for a newly loaded document.
   * Called internally during document loading.
   */
  private _assignDocumentId(filePath: string): string {
    const existing = this._documentIdByPath.get(filePath);
    if (existing !== undefined) {
      return existing;
    }
    const id = `doc-${randomUUID()}`;
    this._documentIdByPath.set(filePath, id);
    return id;
  }

  /**
   * Resolve the currently focused view (spec section 5.2).
   * Returns the viewId, windowId, leafId, and documentId of the active pane.
   */
  public getFocusedView():
    | {
        viewId: string;
        windowId: string;
        leafId: string;
        documentId: string | undefined;
      }
    | undefined {
    if (this._lastEditor.windowId === undefined || this._lastEditor.leafId === undefined) {
      return undefined;
    }
    const activePath = this.getActiveFile(this._lastEditor.leafId);
    if (activePath === null) {
      return undefined;
    }
    return {
      viewId: `view-${this._lastEditor.windowId}-${this._lastEditor.leafId}`,
      windowId: this._lastEditor.windowId,
      leafId: this._lastEditor.leafId,
      documentId: this.getDocumentId(activePath),
    };
  }

  /**
   * Create a snapshot token bound to documentId + version + content hash
   * (spec section 4). The snapshot identifies the target during proposal
   * submission, not the current focus.
   */
  public createSnapshot(
    documentId: string,
  ): { token: string; version: number; sha256: string } | undefined {
    const filePath = this.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const doc = this.documents.find((d) => d.filePath === filePath);
    if (doc === undefined) {
      return undefined;
    }
    const content = doc.document.toString();
    const sha256 = sha256Text(content);
    const payload = JSON.stringify({
      documentId,
      version: doc.currentVersion,
      sha256,
    });
    const encoded = Buffer.from(payload, "utf8").toString("base64url");
    return {
      token: `snap_v1_${encoded}`,
      version: doc.currentVersion,
      sha256,
    };
  }

  /**
   * Parse and validate a snapshot token. Returns the bound documentId,
   * version, and sha256, or undefined if the token is malformed.
   */
  public static parseSnapshotToken(
    token: string,
  ): { documentId: string; version: number; sha256: string } | undefined {
    if (!token.startsWith("snap_v1_")) {
      return undefined;
    }
    try {
      const encoded = token.slice("snap_v1_".length);
      const payload = Buffer.from(encoded, "base64url").toString("utf8");
      const parsed = JSON.parse(payload) as {
        documentId: string;
        version: number;
        sha256: string;
      };
      if (
        typeof parsed.documentId !== "string" ||
        typeof parsed.version !== "number" ||
        typeof parsed.sha256 !== "string"
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Read the live buffer for a document (spec section 5.3).
   * Returns the current working text and a snapshot token.
   */
  public readLiveBuffer(
    documentId: string,
    startLine?: number,
    endLine?: number,
  ):
    | {
        content: string;
        snapshot: string;
        version: number;
        sha256: string;
        lineCount: number;
        truncated: boolean;
      }
    | undefined {
    const filePath = this.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const doc = this.documents.find((d) => d.filePath === filePath);
    if (doc === undefined) {
      return undefined;
    }
    const fullContent = doc.document.toString();
    const lines = fullContent.split("\n");
    const totalLines = lines.length;
    let content = fullContent;
    let truncated = false;
    if (startLine !== undefined && endLine !== undefined) {
      // CLI line ranges are one-based and inclusive (spec section 5.3)
      const start = Math.max(0, startLine - 1);
      const end = Math.min(totalLines, endLine);
      content = lines.slice(start, end).join("\n");
      truncated = end < totalLines;
    }
    const snap = this.createSnapshot(documentId);
    if (snap === undefined) {
      return undefined;
    }
    return {
      content,
      snapshot: snap.token,
      version: snap.version,
      sha256: snap.sha256,
      lineCount: totalLines,
      truncated,
    };
  }

  /**
   * Submit a proposal patch against a snapshot (spec section 6).
   * Atomically: resolve snapshot → verify version+hash → parse patch →
   * apply with zero fuzz → update working text → return review state.
   */
  public async submitProposal(
    snapshot: string,
    patch: string,
    clientRequestId: string,
    description?: string,
    expectedReviewGeneration?: number,
  ): Promise<
    | SubmittedProposalResponse
    | {
        ok: false;
        code: string;
        message: string;
      }
  > {
    const parsed = DocumentManager.parseSnapshotToken(snapshot);
    if (parsed === undefined) {
      return {
        ok: false,
        code: "PATCH_INVALID",
        message: "Invalid snapshot token.",
      };
    }
    const { documentId, version, sha256 } = parsed;

    const idempotencyKey = `${documentId}:${clientRequestId}`;
    const fingerprint = sha256Text(
      JSON.stringify({
        documentId,
        snapshot,
        patch,
        description,
        expectedReviewGeneration,
      }),
    );
    const idempotent = this._proposalIdempotency.get(idempotencyKey);
    if (idempotent !== undefined) {
      if (idempotent.fingerprint !== fingerprint) {
        return {
          ok: false,
          code: "IDEMPOTENCY_CONFLICT",
          message: "clientRequestId was already used for a different proposal request.",
        };
      }
      return idempotent.response;
    }

    const filePath = this.getDocumentPath(documentId);
    if (filePath === undefined) {
      return {
        ok: false,
        code: "DOCUMENT_NOT_FOUND",
        message: "Document not found.",
      };
    }
    const doc = this.documents.find((d) => d.filePath === filePath);
    if (doc === undefined) {
      return {
        ok: false,
        code: "DOCUMENT_CLOSED",
        message: "Document is no longer open.",
      };
    }
    // Verify version and hash
    const currentContent = doc.document.toString();
    const currentSha256 = sha256Text(currentContent);
    if (doc.currentVersion !== version || currentSha256 !== sha256) {
      return {
        ok: false,
        code: "REVISION_MISMATCH",
        message: "The document changed after the snapshot was read.",
      };
    }

    // Check if a review is already active; if not, open one
    const activeReview = this._reviewStore.getReview(documentId);
    const currentGeneration = activeReview === undefined ? 0 : activeReview.generation;
    if (expectedReviewGeneration !== undefined && expectedReviewGeneration !== currentGeneration) {
      return {
        ok: false,
        code: "REVIEW_GENERATION_MISMATCH",
        message: "The review generation no longer matches.",
      };
    }
    if (activeReview === undefined) {
      // Open a new review with the patch as the initial packet
      try {
        const diskContent = normalizeText(await this._app.fsal.loadAnySupportedFile(filePath));
        const diskSha = sha256Text(diskContent);
        this._reviewStore.openReview({
          documentId,
          documentPath: filePath,
          baselineText: currentContent,
          diskBaselineSha256: diskSha,
          initialPatch: {
            patchFormat: "unified-diff",
            patch,
            description,
            clientRequestId,
          },
        });
      } catch (err) {
        return {
          ok: false,
          code: "PATCH_INVALID",
          message: err instanceof Error ? err.message : "Invalid patch.",
        };
      }
      // Broadcast the review start to renderers
      const review = this._reviewStore.getReview(documentId)!;
      this._applyWorkingTextToDocument(filePath, review.workingText);
      this._broadcastReviewState(filePath, review);
      const newContent = doc.document.toString();
      const newSha256 = sha256Text(newContent);
      const status = this._reviewStore.getReviewStatus(documentId)!;
      const response: SubmittedProposalResponse = {
        ok: true,
        packetId: review.packets[0].packetId,
        reviewId: review.reviewId,
        documentId,
        documentRevision: {
          version: doc.currentVersion,
          sha256: newSha256,
        },
        reviewGeneration: status.generation,
        unresolvedChunks: status.unresolvedChunks,
        state: status.state,
      };
      this._proposalIdempotency.set(idempotencyKey, { fingerprint, response });
      return response;
    }

    // Submit as an additional packet
    const result = this._reviewStore.submitPacket(documentId, {
      patchFormat: "unified-diff",
      patch,
      description,
      clientRequestId,
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: "message" in result ? result.message : "Patch rejected.",
      };
    }
    // Update the document's working text
    const review = this._reviewStore.getReview(documentId)!;
    this._applyWorkingTextToDocument(filePath, review.workingText);
    this._broadcastReviewState(filePath, review);
    const newContent = doc.document.toString();
    const newSha256 = sha256Text(newContent);
    const response: SubmittedProposalResponse = {
      ok: true,
      packetId: result.packetId,
      reviewId: result.reviewId,
      documentId,
      documentRevision: { version: doc.currentVersion, sha256: newSha256 },
      reviewGeneration: result.generation,
      unresolvedChunks: result.unresolvedChunks,
      state: result.state,
    };
    this._proposalIdempotency.set(idempotencyKey, { fingerprint, response });
    return response;
  }

  /**
   * Clear all unresolved suggestions for a review.
   * Atomically mutates store, applies working text to document, broadcasts state,
   * and returns the post-mutation document revision.
   */
  public clearReview(reviewId: string):
    | {
        ok: true;
        reviewId: string;
        documentId: string;
        state: ReviewState;
        documentRevision: { version: number; sha256: string };
        reviewGeneration: number;
        unresolvedChunks: number;
      }
    | { ok: false; code: string; message: string } {
    // Find documentId by reviewId
    let documentId: string | undefined;
    for (const r of this._reviewStore.listReviews()) {
      if (r.reviewId === reviewId) {
        documentId = r.documentId;
        break;
      }
    }
    if (documentId === undefined) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "Review not found.",
      };
    }
    const result = this._reviewStore.clearUnresolved(documentId);
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }
    const filePath = this.getDocumentPath(documentId);
    if (filePath !== undefined) {
      this._applyWorkingTextToDocument(filePath, result.workingText);
      this._broadcastReviewCleared(filePath, reviewId);
    }
    const doc =
      filePath !== undefined ? this.documents.find((d) => d.filePath === filePath) : undefined;
    return {
      ok: true,
      reviewId: result.reviewId,
      documentId,
      state: result.state,
      documentRevision: doc
        ? {
            version: doc.currentVersion,
            sha256: sha256Text(doc.document.toString()),
          }
        : { version: 0, sha256: "" },
      reviewGeneration: result.generation,
      unresolvedChunks: result.unresolvedChunks,
    };
  }

  /**
   * Retract a proposal packet.
   * Atomically mutates store, applies working text to document, broadcasts state,
   * and returns the post-mutation document revision.
   */
  public retractProposal(packetId: string):
    | {
        ok: true;
        retracted: true;
        packetId: string;
        reviewId: string;
        documentId: string;
        reviewGeneration: number;
        unresolvedChunks: number;
        documentRevision: { version: number; sha256: string };
      }
    | {
        ok: false;
        code: string;
        message: string;
        reviewId: string;
        canClearUnresolved: true;
      } {
    const result = this._reviewStore.retractPacket(packetId);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        reviewId: result.reviewId,
        canClearUnresolved: result.canClearUnresolved,
      };
    }
    const documentId = result.documentId;
    const filePath = this.getDocumentPath(documentId);
    const review = this._reviewStore.getReview(documentId);
    if (filePath !== undefined && review !== undefined) {
      this._applyWorkingTextToDocument(filePath, review.workingText);
      this._broadcastReviewState(filePath, review);
    }
    const doc =
      filePath !== undefined ? this.documents.find((d) => d.filePath === filePath) : undefined;
    return {
      ok: true,
      retracted: true,
      packetId: result.packetId,
      reviewId: result.reviewId,
      documentId,
      reviewGeneration: result.generation,
      unresolvedChunks: result.unresolvedChunks,
      documentRevision: doc
        ? {
            version: doc.currentVersion,
            sha256: sha256Text(doc.document.toString()),
          }
        : { version: 0, sha256: "" },
    };
  }

  /**
   * Get the review store for direct agent API method dispatch.
   */
  public get reviewStore(): ReviewDiffStore {
    return this._reviewStore;
  }

  /**
   * Expose the loaded documents array for the agent API provider to enumerate
   * open documents (spec section 5.2).
   */
  public get loadedDocuments(): readonly Document[] {
    return this.documents;
  }

  /**
   * Broadcast the current review state to all renderers displaying a document.
   * Constructs a legacy-compatible ReviewDiffSession for the renderer.
   */
  private _broadcastReviewState(
    filePath: string,
    review: ReturnType<ReviewDiffStore["getReview"]>,
  ): void {
    if (review === undefined) {
      return;
    }
    // Construct a legacy ReviewDiffSession for renderer compat
    const legacySession: ReviewDiffSession = {
      id: review.reviewId,
      reviewGeneration: review.generation,
      documentPath: filePath,
      baselineSha256: sha256Text(review.baselineText),
      diskBaselineSha256: review.diskFenceSha256,
      baselineText: review.baselineText,
      originalText: review.referenceText,
      proposedText: review.workingText,
      currentText: review.workingText,
    };
    this.broadcastEvent(DP_EVENTS.REVIEW_DIFF, {
      filePath,
      reviewDiffSession: legacySession,
      reviewState: {
        reviewId: review.reviewId,
        generation: review.generation,
        referenceText: review.referenceText,
        workingText: review.workingText,
        unresolvedChunks:
          this._reviewStore.getReviewStatus(review.documentId)?.unresolvedChunks ?? 0,
      },
    });
  }

  /**
   * Broadcast a review-cleared signal to all renderers displaying a document.
   * Tells the renderer to exit review mode (spec section 13: clear review mode
   * when the provider closes or invalidates the session).
   */
  private _broadcastReviewCleared(filePath: string, reviewId: string): void {
    this.broadcastEvent(DP_EVENTS.REVIEW_DIFF, {
      filePath,
      reviewDiffSession: undefined,
      reviewCleared: true,
      reviewId,
    });
  }

  /**
   * Apply the working text from a review to the live document.
   * This updates the CodeMirror Text without going through the collab update
   * path — the provider is the authority.
   */
  private _applyWorkingTextToDocument(filePath: string, workingText: string): void {
    const doc = this.documents.find((d) => d.filePath === filePath);
    if (doc === undefined) {
      return;
    }
    const currentText = doc.document.toString();
    if (currentText === workingText) {
      return;
    }
    // Replace the document content atomically
    const newText = Text.of(workingText.split("\n"));
    const changes = ChangeSet.of(
      [{ from: 0, to: doc.document.length, insert: workingText }],
      doc.document.length,
    );
    // Serialize before mutating: serializeChangeSet throws on a shape it does
    // not recognize, and a throw between the version bump and the push would
    // consume a version number with no update for peers to pull — a dirty
    // buffer that can never be saved, indistinguishable from a deadlock.
    const update = {
      changes: serializeChangeSet(changes),
      clientID: "review-diff-store",
    };
    doc.document = newText;
    doc.currentVersion += 1;
    doc.updates.push(update);
    while (doc.updates.length > MAX_VERSION_HISTORY) {
      doc.updates.shift();
      doc.minimumVersion += 1;
    }
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      filePath,
      status: "modification",
    });
  }
}
