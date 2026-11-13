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
import isErrnoException from "@common/util/is-errno-exception";
import isFile from "@common/util/is-file";
import serializeChangeSet from "@common/util/serialize-change-set";
import { sha256Text } from "@common/util/sha256";
import type {
  AgentErrorCode,
  AgentEvent,
  AgentEventType,
  ProposalClaim,
} from "@dts/common/agent-api";
import type {
  AnnotationActor,
  AnnotationMessage,
  TextAnnotation,
} from "@dts/common/annotation-domain";
import {
  COLLABORATION_FILE_UNREADABLE_CHANNEL,
  COLLABORATION_FILE_UNWRITABLE_CHANNEL,
  type CollaborationFileUnreadableBroadcast,
  type CollaborationFileUnwritableBroadcast,
  type DocumentCollaborationSession,
  type OwnerlessCollaborationFile,
  type UnreadableCollaborationFile,
  type WorkspaceCollaborationListing,
} from "@dts/common/document-collaboration";
import {
  type BranchNodeJSON,
  DocumentType,
  DP_EVENTS,
  FILE_REMOVED_KEPT_CHANNEL,
  type FileRemovedKeptBroadcast,
  type LeafNodeJSON,
  type OpenDocument,
  REMOTE_CHANGE_KEPT_CHANNEL,
  type RefusedAction,
  type RemoteChangeKeptBroadcast,
  SAVE_REFUSED_CHANNEL,
  type SaveFileResult,
  type SaveRefusal,
  type SaveRefusalReason,
  type SaveRefusedBroadcast,
  type SerializedUpdate,
} from "@dts/common/documents";
import type { AnyDescriptor, CodeFileDescriptor, MDFileDescriptor } from "@dts/common/fsal";
import type { DocumentLocation, SourceRange, WorkspaceTextEdit } from "@dts/common/references";
import { IpcListener } from "@electron-toolkit/typed-ipc/main";
import type { ConfigOptions } from "@providers/config/get-config-template";
import { type TabManager } from "@providers/documents/document-tree/tab-manager";
import type { FolderNotListed } from "@providers/fsal/util/read-directory";
import ProviderContract, { type IPCMessage } from "@providers/provider-contract";
import { strict as assert } from "assert";
import { randomUUID } from "crypto";
import { app, type BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from "electron";
import EventEmitter from "events";
import { constants as FSConstants } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { bibliographyFiles, documentBibliography } from "source/app/util/document-bibliographies";
import { openPath } from "source/app/util/open-path";
import { throwFailures } from "source/app/util/run-each-step";
import { showRefusalInWindow } from "source/app/util/show-refusal-in-window";
import { showStoreWriteFailure } from "source/app/util/show-store-write-failure";
import {
  getDocumentTypeForExtension,
  hasImageExt,
  hasMdOrCodeExt,
  hasPDFExt,
} from "source/common/util/file-extention-checks";
import isDir from "source/common/util/is-dir";
import {
  innermostRoot,
  isAtOrInsideRoot,
  isInsideRoot,
} from "source/common/util/renderer-path-polyfill";
import { v4 as uuid4 } from "uuid";
import { type AppServiceContainer } from "../../app-service-container";
import { CollaborationSidecarUnreadableError } from "./collaboration-sidecar-store";
import {
  type AgentEventPayload,
  type AnnotationFailure,
  CollaborationApplicationService,
  type CollaborationDocumentAuthority,
  type PreparedDocumentMutation,
  type ReviewFailure,
  type ReviewMutationPrecondition,
  type ReviewQueryPort,
  type ReviewRecoveryInput,
  type ReviewSavePreparation,
  type SubmittedProposal,
} from "./document-collaboration-application-service";
import { DocumentTree, type DTLeaf } from "./document-tree";
import {
  collaborationSessionFor,
  normalizeText,
  type ReviewStatus,
  reviewFromSidecar,
} from "./review-diff-store";
import { ReviewStateNotMovedError } from "./review-state-not-moved-error";
import {
  type AcceptAllChunksResponse,
  type AddReviewCommentResponse,
  type ChunkCommentResponse,
  type ChunkDecision,
  type ChunkDecisionResponse,
  type ClearReviewResponse,
  type DiscardReviewResponse,
  type ProposalRefusal,
  type ReapplyReviewResponse,
  type RetractProposalResponse,
} from "./review-transitions";

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
    getAllLoadedDescriptors?(): Promise<AnyDescriptor[]>;
  } & Pick<
    AppServiceContainer["fsal"],
    | "getAnyDirectoryDescriptor"
    | "getDescriptorFor"
    | "getDescriptorForAnySupportedFile"
    | "loadAnySupportedFile"
    | "readDirectoryRecursively"
    | "testAccess"
    | "writeTextFile"
  >;
  log: Pick<AppServiceContainer["log"], "error" | "info" | "verbose" | "warning">;
  recentDocs: Pick<AppServiceContainer["recentDocs"], "add" | "markEdited">;
  /**
   * The live-reference seam of the references provider (issue #53): this
   * manager is the document authority and DRIVES the provider's live
   * overlay at its own mutation points — load/change reports and
   * close/move/reload drops. The provider reads the buffer text back
   * through readMarkdownBufferContent().
   */
  references: {
    reportAuthorityBuffer: (filePath: string, immediate?: boolean) => void;
    dropAuthorityBuffer: (filePath: string) => void;
  };
  stats: Pick<AppServiceContainer["stats"], "updateCounts">;
  windows: Pick<
    AppServiceContainer["windows"],
    | "askSaveChanges"
    | "getFirstMainWindow"
    | "getMainWindowKey"
    | "saveFile"
    | "showErrorMessage"
    | "tellMainWindows"
  >;
};

/** What the provider tells the author about one document (_tellAbout). */
type DocumentMessage =
  | SaveRefusedBroadcast
  | FileRemovedKeptBroadcast
  | RemoteChangeKeptBroadcast
  | CollaborationFileUnreadableBroadcast
  | CollaborationFileUnwritableBroadcast;

// Keep no more than this many updates.
const MAX_VERSION_HISTORY = 100;
/**
 * What each autosave mode means: the time from the last change to the save.
 * "immediately" still waits half a second, so that a save does not race the
 * next change on a slow system.
 */
const autoSaveDelayMs: Record<Exclude<ConfigOptions["editor"]["autoSave"], "off">, number> = {
  immediately: 500,
  delayed: 5000,
};

export type DocumentsUpdateContext = {
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
   * A document's whole collaboration state — its annotations, and its
   * review if one is active — as one snapshot. Broadcast on every
   * annotation and review mutation (DP_EVENTS.DOCUMENT_COLLABORATION); the
   * renderer's document-collaboration Pinia store is the only reader.
   */
  collaborationSession?: DocumentCollaborationSession;
  /**
   * The renderer-ready failure payload for FILE_REMOTE_CHANGE_ERROR events.
   * The message is suitable for the visible error surface; diagnostic retains
   * the complete stack or serialized rejection for renderer diagnostics.
   */
  documentLoadError?: {
    message: string;
    diagnostic: string;
  };
};

/** A close that the provider refused, and what the author's answer to it does. */
interface RefusedClose {
  /** Repeats the close that was refused. */
  repeat: () => Promise<void>;
  /**
   * The author answered the prompt of that close with "discard", and the
   * discard failed: the buffer still holds the text that the author threw
   * away.
   */
  textDiscarded: boolean;
}

/**
 * The message of a refusal: what the application did not do and the cause.
 * The message of a refused quit also says what its action does, because the
 * label "Quit anyway" does not name the document that it changes.
 */
type RefusalMessage = (cause: string) => string;

const REVIEW_NOT_SAVED: Record<RefusedAction, RefusalMessage> = {
  close: (cause) => `The review could not be saved, so this document was left open: ${cause}`,
  reload: (cause) => `The review could not be saved, so the disk version was not loaded: ${cause}`,
  quit: (cause) =>
    `The review could not be saved, so the application did not quit: ${cause}\n` +
    '"Quit anyway" quits. The review stays as it was last saved, and it returns when the document is opened.',
};

const CHANGES_NOT_DISCARDED: Record<"close" | "quit", RefusalMessage> = {
  close: (cause) =>
    `The unsaved changes could not be discarded, so this document was left open: ${cause}`,
  quit: (cause) =>
    `The unsaved changes could not be discarded, so the application did not quit: ${cause}\n` +
    '"Quit anyway" closes this document without its unsaved changes and quits.',
};

/**
 * Holds all information associated with a document that is currently loaded
 */
interface Document {
  /**
   * Opaque document identifier. Stable for the lifetime of
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

export type DocumentAuthorityIPCContract = {
  "get-document": {
    request: { payload: { filePath: string } };
    response: { content: string; type: DocumentType; startVersion: number };
  };
  "pull-updates": {
    request: { payload: { filePath: string; version: number } };
    response: SerializedUpdate[] | false;
  };
  "push-updates": {
    request: {
      payload: {
        filePath: string;
        version: number;
        updates: SerializedUpdate[];
      };
    };
    response: boolean;
  };
};

export type DocumentAuthorityIPCAPI = IPCMessage<DocumentAuthorityIPCContract>;

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
export type DocumentManagerIPCContract = {
  "set-pinned": {
    request: { payload: LeafLoc & { path: string; pinned: boolean } };
    response: undefined;
  };
  "retrieve-tab-config": {
    request: { payload: { windowId: string } };
    response: LeafNodeJSON | BranchNodeJSON;
  };
  // targetRange/sourceLocation are additive (issue #1 Phase 5): a reference
  // jump lands on targetRange in the opened document and stamps the origin
  // pane's current history entry with sourceLocation so Back can restore it.
  // windowId/leafId/newTab are optional, exactly like the corresponding
  // openFile() parameters: callers such as the sidebar and renderers open
  // files without naming a pane and let the manager pick one.
  "open-file": {
    request: {
      payload: {
        path: string;
        windowId?: string;
        leafId?: string;
        newTab?: boolean;
        targetRange?: SourceRange;
        sourceLocation?: DocumentLocation;
      };
    };
    response: boolean;
  };
  "close-file": {
    request: { payload: LeafLoc & { path: string } };
    response: boolean;
  };
  "reopen-closed-tab": {
    request: { payload: { windowId: string } };
    response: boolean;
  };
  "close-all-tabs": {
    /** Without `leafId` each pane of the window; with it that pane only. */
    request: { payload: { windowId: string; leafId?: string } };
    response: boolean;
  };
  "save-all": {
    request: { payload: { windowId: string } };
    response: boolean;
  };
  "save-all-and-close": {
    request: { payload: { windowId: string } };
    response: boolean;
  };
  "close-file-everywhere": {
    request: { payload: { path: string } };
    response: boolean;
  };
  "load-from-disk": {
    request: { payload: { path: string } };
    response: undefined;
  };
  "close-without-review": {
    request: { payload: { documentId: string } };
    response: boolean;
  };
  // The path of the copy, or undefined when the author chose no file.
  "save-copy": {
    request: { payload: { path: string } };
    response: string | undefined;
  };
  "sort-open-files": {
    request: { payload: LeafLoc & { newOrder: string[] } };
    response: undefined;
  };
  "get-file-modification-status": {
    request: { payload?: undefined };
    response: string[];
  };
  // The store's hydration pull: one caller resolves it and caches the
  // result, every other pane of the same path reads the cache. Every
  // subsequent update reaches the store through the broadcast alone.
  "get-collaboration-session": {
    request: { payload: { path: string } };
    response: DocumentCollaborationSession | undefined;
  };
  "get-workspace-collaboration-sessions": {
    request: { payload: { paths: string[] } };
    response: WorkspaceCollaborationListing;
  };
  "set-aside-collaboration-sidecar": {
    request: { payload: { file: string } };
    response: string;
  };
  "move-file": {
    request: {
      payload: {
        originWindow: string;
        targetWindow: string;
        originLeaf: string;
        targetLeaf: string;
        path: string;
      };
    };
    response: undefined;
  };
  "split-leaf": {
    request: {
      payload: {
        originWindow: string;
        originLeaf: string;
        direction: "horizontal" | "vertical";
        insertion: "before" | "after";
        path?: string;
        fromWindow?: string;
        fromLeaf?: string;
      };
    };
    response: undefined;
  };
  "close-leaf": { request: { payload: LeafLoc }; response: undefined };
  "focus-leaf": { request: { payload: LeafLoc }; response: undefined };
  "set-branch-sizes": {
    request: {
      payload: { windowId: string; branchId: string; sizes: number[] };
    };
    response: undefined;
  };
  // location is additive (issue #1 Phase 5): the current DocumentLocation of
  // the navigating pane, stamped onto the current history entry before the
  // move so the opposite direction can restore it.
  "navigate-forward": {
    request: { payload: LeafLoc & { location?: DocumentLocation } };
    response: undefined;
  };
  "navigate-back": {
    request: { payload: LeafLoc & { location?: DocumentLocation } };
    response: undefined;
  };
  // Additive (issue #1 Phase 5): whether the leaf's session history has
  // entries before/after the pointer (Back/Forward enabled state).
  "get-navigation-state": {
    request: { payload: LeafLoc };
    response: { canGoBack: boolean; canGoForward: boolean };
  };
};

export type DocumentManagerIPCAPI = IPCMessage<DocumentManagerIPCContract>;

/** The document to save. */
export interface SaveFileInput {
  path: string;
}

/** One chunk decision, fenced on the generation and working text it was formed against. */
export type ReviewDecisionInput = {
  reviewId: string;
  chunkId: string;
  decision: ChunkDecision;
} & ReviewMutationPrecondition;

/**
 * A comment attached to one outstanding suggestion without deciding it.
 * The stable suggestion id selects the comment owner.
 */
export type ReviewChunkCommentInput = {
  reviewId: string;
  chunkId: string;
  text: string;
} & ReviewMutationPrecondition;

/** Accepting every remaining chunk, under the same fence one decision uses. */
export type ReviewAcceptAllInput = {
  reviewId: string;
} & ReviewMutationPrecondition;
export type WorkspaceReviewAcceptAllInput = {
  path: string;
  reviewId: string;
} & ReviewMutationPrecondition;

/** Discarding a review, under the same fence one decision uses. */
export type ReviewClearInput = {
  reviewId: string;
} & ReviewMutationPrecondition;

/**
 * A comment adjudicates nothing and moves no text, so it fences on the review
 * generation alone.
 */
export interface ReviewCommentInput {
  reviewId: string;
  text: string;
  expectedReviewGeneration: number;
}

/**
 * The owner comments on a selection. `path` resolves to the loaded
 * document's documentId inside the handler; there is no `actor` field here
 * because the renderer's owner-facing channel is the only caller and the
 * handler hardcodes `'owner'` — an agent has no path to this channel at all.
 */
export interface CreateAnnotationIpcInput {
  path: string;
  from: number;
  to: number;
  instruction: string;
  expectedAnnotationGeneration: number;
}

/** One more turn of an annotation thread, posted by the owner. */
export interface AddAnnotationMessageIpcInput {
  path: string;
  annotationId: string;
  text: string;
  expectedAnnotationGeneration: number;
}

/** The shape shared by resolve, reopen, and delete: an id and a fence. */
export interface AnnotationLifecycleIpcInput {
  path: string;
  annotationId: string;
  expectedAnnotationGeneration: number;
}

/** Reattach carries the owner's freshly picked range alongside the id. */
export interface ReattachAnnotationIpcInput {
  path: string;
  annotationId: string;
  from: number;
  to: number;
  expectedAnnotationGeneration: number;
}

/**
 * The two bulk owner moves need only the document and the fence of the
 * snapshot the panel rendered: the batch names its targets itself, so
 * neither carries an annotationId. The resolve batch's scope picks acted
 * remediation results ("acted", the default server-side) or every open
 * thread ("open").
 */
export interface BulkAnnotationIpcInput {
  path: string;
  expectedAnnotationGeneration: number;
}

export interface BulkAnnotationResolutionIpcInput extends BulkAnnotationIpcInput {
  /** The open annotations that the batch takes: those an agent marked acted, or all. */
  scope: "acted" | "open";
}

/**
 * The document operations the renderer invokes on their own typed channels,
 * one handler signature each. This provider owns the schema; the renderer
 * bridge composes it, so a wrong payload or a changed return type is a
 * compile error at the call site with no second map to keep in step.
 */
/** A recovery action on a frozen review, from the owner. */
export interface ReviewRecoveryIpcInput {
  reviewId: string;
  expectedReviewGeneration: number;
}

export type DocumentIpcHandlers = {
  "documents:save-file": (input: SaveFileInput) => SaveFileResult;
  "documents:decide-review-chunk": (
    input: ReviewDecisionInput,
  ) => ChunkDecisionResponse | ReviewFailure;
  "documents:comment-review-chunk": (
    input: ReviewChunkCommentInput,
  ) => ChunkCommentResponse | ReviewFailure;
  "documents:accept-all-review-chunks": (
    input: ReviewAcceptAllInput,
  ) => AcceptAllChunksResponse | ReviewFailure;
  "documents:accept-all-workspace-review-chunks": (
    input: WorkspaceReviewAcceptAllInput,
  ) => AcceptAllChunksResponse | ReviewFailure;
  "documents:clear-review": (input: ReviewClearInput) => ClearReviewResponse | ReviewFailure;
  "documents:add-review-comment": (
    input: ReviewCommentInput,
  ) => AddReviewCommentResponse | ReviewFailure;
  "documents:reapply-review": (
    input: ReviewRecoveryIpcInput,
  ) => ReapplyReviewResponse | ReviewFailure;
  "documents:discard-invalidated-review": (
    input: ReviewRecoveryIpcInput,
  ) => DiscardReviewResponse | ReviewFailure;
  "documents:return-invalidated-review": (
    input: ReviewRecoveryIpcInput,
  ) => AddReviewCommentResponse | ReviewFailure;
  "documents:create-annotation": (
    input: CreateAnnotationIpcInput,
  ) => TextAnnotation | AnnotationFailure;
  "documents:add-annotation-message": (
    input: AddAnnotationMessageIpcInput,
  ) => AnnotationMessage | AnnotationFailure;
  "documents:resolve-annotation": (
    input: AnnotationLifecycleIpcInput,
  ) => TextAnnotation | AnnotationFailure;
  "documents:reopen-annotation": (
    input: AnnotationLifecycleIpcInput,
  ) => TextAnnotation | AnnotationFailure;
  "documents:reattach-annotation": (
    input: ReattachAnnotationIpcInput,
  ) => TextAnnotation | AnnotationFailure;
  "documents:delete-annotation": (
    input: AnnotationLifecycleIpcInput,
  ) => TextAnnotation | AnnotationFailure;
  "documents:resolve-acted-annotations": (
    input: BulkAnnotationResolutionIpcInput,
  ) => { resolved: TextAnnotation[] } | AnnotationFailure;
  "documents:clear-resolved-annotations": (
    input: BulkAnnotationIpcInput,
  ) => { deleted: TextAnnotation[] } | AnnotationFailure;
};

export default class DocumentManager
  extends ProviderContract
  implements CollaborationDocumentAuthority
{
  /**
   * This array holds all open windows, here represented as document trees
   *
   * @var {DocumentTree[]}
   */
  private readonly _windows: DocumentWindows;
  private readonly _closedTabs: Map<string, string[]>;
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
   * The disk modification time of the last remote change announced for each
   * kept document. A watcher emits several events for one change; the user
   * hears of each disk version once.
   */
  private readonly _announcedRemoteModtime: Map<string, number>;

  /**
   * Paths whose most recent remote reload failure has already been surfaced.
   * Watchdog duplicate events must not produce duplicate renderer toasts.
   *
   * @var {string[]}
   */
  private readonly _remoteChangeErrorShownFor: string[];

  /**
   * Committed review state. The store owns suggestions, the packet ledger,
   * and the review generation. Every decision about them is a pure
   * transition this provider prepares, persists, and commits.
   */

  /**
   * The agent-visible event bus. The store used to be an EventEmitter and
   * announce its own mutations, which meant a mutation was announced the
   * instant the store changed — before the document had the working text the
   * event described. Emission belongs to whoever commits, so it lives here.
   */
  public readonly agentEvents = new EventEmitter();

  /**
   * The id of each document path, and the path of each document id. The
   * two maps change together (_assignDocumentId, _moveDocumentId): an id
   * names one path, and a path has one id.
   */
  private readonly _documentIdByPath: Map<string, string>;
  private readonly _documentPathById: Map<string, string>;

  /**
   * The closes that the provider refused, by the id of the document that
   * stopped each one: its collaboration state could not be written, or the
   * discard of its unsaved text failed. closeWithoutReview acts on the
   * entry when the author decides to close without that state.
   */
  private readonly _refusedCloses: Map<string, RefusedClose>;

  /** The load of each document that is loading now (getDocument). */
  private readonly _pendingLoads = new Map<
    string,
    Promise<{ content: string; type: DocumentType; startVersion: number }>
  >();

  /**
   * The one owner of a document's collaboration transactions — its review
   * and its annotations: per-document locking, persist-before-commit
   * ordering, and committed-event emission. Every mutation of either half,
   * from every transport, runs through it, and one sidecar per document (in
   * app data, keyed by canonical path) is what it writes through to.
   */
  private readonly _reviewApplication: CollaborationApplicationService;

  /**
   * This holds all currently opened documents somewhere across the app.
   *
   * @var {Document[]}
   */
  private readonly documents: Document[];

  /**
   * Ends when the last call of synchronizeDatabases named its bibliographies
   * to the citation provider. The next call collects after it.
   */
  private bibliographiesNamed: Promise<void> = Promise.resolve();

  private _shuttingDown: boolean;

  /** True while the before-quit save-or-discard dialog is unanswered. */
  private _quitPromptOpen: boolean;

  /** The time of the last update that an editor sent; 0 for none. */
  private _lastEditorInputAt = 0;

  private readonly _lastEditor: {
    windowId: string | undefined;
    leafId: string | undefined;
  };

  constructor(private readonly _app: DocumentManagerApp) {
    super();

    const containerPath = path.join(app.getPath("userData"), "documents.yaml");

    this._windows = {};
    this._closedTabs = new Map();
    this._emitter = new EventEmitter();
    this._config = new PersistentDataContainer(containerPath, "yaml", (filePath, failure) => {
      showStoreWriteFailure(this._app.log, this._app.windows, filePath, failure);
    });
    this._ignoreChanges = [];
    this._announcedRemoteModtime = new Map();
    this._remoteChangeErrorShownFor = [];
    this._reviewApplication = new CollaborationApplicationService({
      authority: this,
      sidecarDirectory: path.join(app.getPath("userData"), "review-sidecars"),
      emit: (event, payload) => {
        this.emitAgentEvent(event, payload);
      },
      warn: (message) => {
        this._app.log.warning(`[DocumentManager] ${message}`);
      },
    });
    this._documentIdByPath = new Map();
    this._documentPathById = new Map();
    this._refusedCloses = new Map();
    this.documents = [];
    this._shuttingDown = false;
    this._quitPromptOpen = false;
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
      // A file that was removed and is written again arrives as `add`: the
      // watcher follows the path of a tab through a removal.
      if (changeEvent !== "unlink" && changeEvent !== "change" && changeEvent !== "add") {
        this._app.log.warning(
          `[DocumentManager] Received unexpected event ${String(changeEvent)} for ${changedPath}.`,
        );
        return;
      }
      if (this._ignoreChanges.includes(changedPath) && changeEvent !== "unlink") {
        this._app.log.info(`[DocumentManager] Ignoring change for ${changedPath}`);
        this._ignoreChanges.splice(this._ignoreChanges.indexOf(changedPath), 1);
        return;
      } else {
        this._app.log.info(`[DocumentManager] Processing ${changeEvent} for ${changedPath}`);
      }

      if (changeEvent === "unlink" && this.isModified(changedPath)) {
        // The text of the document is only in the application now. The
        // document stays open with it, and the author decides: a save writes
        // the file again, a close asks about the text.
        this._announceRemovedFileKept(changedPath);
      } else if (changeEvent === "unlink") {
        // Close the file everywhere
        this.closeFileEverywhere(changedPath).catch((err: unknown) =>
          this._app.log.error(err instanceof Error ? err.message : String(err)),
        );
      } else if (!this.documents.some((doc) => doc.filePath === changedPath)) {
        // Every open tab is watched so that a deletion closes it, but only a
        // tab an editor has shown has a loaded document. An unloaded tab has
        // no buffer to reconcile: it reads the file from disk when shown.
        this._app.log.info(`[DocumentManager] ${changedPath} is not loaded; nothing to reload`);
      } else {
        this.handleRemoteChange(changedPath).catch((err: unknown) => {
          if (this._remoteChangeErrorShownFor.includes(changedPath)) {
            return;
          }
          this._remoteChangeErrorShownFor.push(changedPath);
          setTimeout(() => {
            const index = this._remoteChangeErrorShownFor.indexOf(changedPath);
            if (index >= 0) {
              this._remoteChangeErrorShownFor.splice(index, 1);
            }
          }, 1000);

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
      // Loading a document reattaches its sidecar, and an authority update
      // rewrites the reviewed working text: both are review writers, so both
      // take the same per-document lock every other writer takes.
      switch (command) {
        case "pull-updates":
          return await this.pullUpdates(payload.filePath, payload.version);
        case "push-updates":
          return await this.pushUpdates(payload.filePath, payload.version, payload.updates);
        case "get-document":
          return await this._reviewApplication.withDocumentLock(
            this.ensureDocumentId(payload.filePath),
            async () => await this.getDocument(payload.filePath),
          );
      }
    });

    // The document operations the renderer drives on their own channels. Each
    // one is a single typed handler, so the payload and the response are the
    // handler's own signature rather than a branch of a multiplexer.
    const operations = new IpcListener<DocumentIpcHandlers>();
    operations.handle("documents:save-file", async (_event, input) => {
      return await this.saveFile(input.path);
    });
    operations.handle("documents:decide-review-chunk", async (_event, input) => {
      const { reviewId, chunkId, decision, ...precondition } = input;
      return await this.decideReviewChunk(reviewId, chunkId, decision, precondition);
    });
    operations.handle("documents:comment-review-chunk", async (_event, input) => {
      const { reviewId, chunkId, text, ...precondition } = input;
      return await this.commentReviewChunk(reviewId, chunkId, text, precondition);
    });
    operations.handle("documents:accept-all-review-chunks", async (_event, input) => {
      const { reviewId, ...precondition } = input;
      return await this.acceptAllReviewChunks(reviewId, precondition);
    });
    operations.handle("documents:accept-all-workspace-review-chunks", async (_event, input) => {
      const { path, reviewId, ...precondition } = input;
      return await this._reviewApplication.acceptAllWorkspaceChunks({
        documentId: this.ensureDocumentId(path),
        documentPath: path,
        reviewId,
        precondition,
      });
    });
    operations.handle("documents:clear-review", async (_event, input) => {
      const { reviewId, ...precondition } = input;
      return await this.clearReview(reviewId, precondition);
    });
    operations.handle("documents:add-review-comment", async (_event, input) => {
      return await this.addReviewComment(
        input.reviewId,
        input.text,
        input.expectedReviewGeneration,
      );
    });
    operations.handle("documents:reapply-review", async (_event, input) => {
      return await this.reapplyReview(input.reviewId, input.expectedReviewGeneration);
    });
    operations.handle("documents:discard-invalidated-review", async (_event, input) => {
      return await this.discardInvalidatedReview(input.reviewId, input.expectedReviewGeneration);
    });
    operations.handle("documents:return-invalidated-review", async (_event, input) => {
      const recovery = await this._reviewRecoveryInput(
        input.reviewId,
        input.expectedReviewGeneration,
      );
      return "ok" in recovery
        ? recovery
        : await this._reviewApplication.returnInvalidatedReview(recovery);
    });
    // The owner-facing annotation channels. Each resolves `path` to a
    // documentId before touching the application service, and each
    // hardcodes 'owner' as the actor — the renderer has no field to smuggle
    // a different actor through, since the input types above declare none.
    operations.handle("documents:create-annotation", async (_event, input) => {
      const documentId = this.getDocumentId(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this.createAnnotation(
        documentId,
        "owner",
        input.from,
        input.to,
        input.instruction,
        input.expectedAnnotationGeneration,
      );
    });
    operations.handle("documents:add-annotation-message", async (_event, input) => {
      const documentId = this.getDocumentId(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this.addAnnotationMessage(
        documentId,
        input.annotationId,
        "owner",
        input.text,
        undefined,
        input.expectedAnnotationGeneration,
      );
    });
    operations.handle("documents:resolve-annotation", async (_event, input) => {
      const documentId = this.getDocumentId(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this.resolveAnnotation(
        documentId,
        input.annotationId,
        "owner",
        input.expectedAnnotationGeneration,
      );
    });
    operations.handle("documents:reopen-annotation", async (_event, input) => {
      const documentId = this.getDocumentId(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this.reopenAnnotation(
        documentId,
        input.annotationId,
        "owner",
        input.expectedAnnotationGeneration,
      );
    });
    operations.handle("documents:reattach-annotation", async (_event, input) => {
      const documentId = this.getDocumentId(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this.reattachAnnotation(
        documentId,
        input.annotationId,
        "owner",
        input.from,
        input.to,
        input.expectedAnnotationGeneration,
      );
    });
    operations.handle("documents:delete-annotation", async (_event, input) => {
      const documentId = this.getDocumentId(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this.deleteAnnotation(
        documentId,
        input.annotationId,
        "owner",
        input.expectedAnnotationGeneration,
      );
    });

    // The bulk owner moves over the annotations panel. They must also reach a
    // document no pane shows: the panel's workspace projection carries closed
    // documents' sidecar state, and the remediation backlog these clear sits
    // on documents the agent touched without ever opening them. So unlike the
    // single-id channels above, the path resolves to a documentId through the
    // collaboration sidecar when the document is not open, and each commit
    // runs on the open-or-closed ordering.
    operations.handle("documents:resolve-acted-annotations", async (_event, input) => {
      const documentId = await this._documentIdForBulkOwnerMutation(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this._resolveActedAnnotations(
        documentId,
        input.expectedAnnotationGeneration,
        input.scope,
      );
    });
    operations.handle("documents:clear-resolved-annotations", async (_event, input) => {
      const documentId = await this._documentIdForBulkOwnerMutation(input.path);
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path);
      }
      return await this._deleteResolvedAnnotations(documentId, input.expectedAnnotationGeneration);
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
        case "open-file": {
          const { windowId, leafId, path, newTab, targetRange, sourceLocation } = payload;
          return await this.openFile(windowId, leafId, path, newTab, {
            targetRange,
            sourceLocation,
          }).catch((error: unknown) => {
            showRefusalInWindow(event.sender, "open-file", error);
            throw error;
          });
        }
        case "close-file": {
          const { windowId, leafId, path } = payload;
          return await this.closeFile(windowId, leafId, path);
        }
        case "reopen-closed-tab": {
          return await this.reopenClosedTab(payload.windowId);
        }
        case "close-all-tabs": {
          return await this.closeAllTabs(payload.windowId, payload.leafId);
        }
        case "save-all": {
          return await this.saveAll(payload.windowId);
        }
        case "save-all-and-close": {
          return await this.saveAllAndClose(payload.windowId);
        }
        case "close-file-everywhere": {
          const { path } = payload;
          return this.closeFileEverywhere(path);
        }
        case "load-from-disk": {
          if (!this.documents.some((doc) => doc.filePath === payload.path)) {
            return; // The document was closed; the next open reads the disk.
          }
          await this.notifyRemoteChange(payload.path);
          return;
        }
        case "close-without-review": {
          return await this.closeWithoutReview(payload.documentId);
        }
        case "save-copy": {
          return await this.saveCopy(payload.path);
        }
        case "sort-open-files": {
          const { windowId, leafId, newOrder } = payload;
          this.sortOpenFiles(windowId, leafId, newOrder);
          return;
        }
        case "get-file-modification-status": {
          return this.documents.filter((x) => this.isModified(x.filePath)).map((x) => x.filePath);
        }
        case "get-collaboration-session": {
          const docId = this.getDocumentId(payload.path);
          return docId === undefined
            ? undefined
            : this._collaborationSessionFor(docId, payload.path);
        }
        case "get-workspace-collaboration-sessions": {
          return await this._workspaceCollaborationSessions(payload.paths);
        }
        case "set-aside-collaboration-sidecar": {
          return await this._reviewApplication.setAsideCollaborationSidecar(payload.file);
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
      const parked = this._reviewedDocumentsWithoutPane();
      const unsaved = this._documentsToAskAbout(this.documents);
      if (parked.length === 0 && unsaved.length === 0) {
        this._shuttingDown = true;
        return;
      }
      event.preventDefault();

      // Re-entrancy guard: quit can be requested again while the prompt is
      // open (window-all-closed after the last window dies, the tray, a
      // second Ctrl+Q). Without it, each request stacks another identical
      // dialog over the unanswered first one.
      if (this._quitPromptOpen) {
        return;
      }
      this._quitPromptOpen = true;

      this._settleDocumentsBeforeQuit(parked, unsaved)
        .then((mayQuit) => {
          this._quitPromptOpen = false;
          if (mayQuit) {
            app.quit();
          }
        })
        .catch((err) => {
          this._quitPromptOpen = false;
          this._app.log.error("[DocumentManager] Cannot ask user to save or omit changes!", err);
        });
    });
  } // END constructor

  /**
   * A document whose review has a proposal that the author did not decide
   * on. Its working text holds that proposal, so a prompt that asks about
   * many documents at one time (a quit, a window close) has no answer for
   * it: a save writes the proposal to the file before the author decided on
   * it, and a discard destroys the review. Each change of such a document
   * writes its sidecar before the buffer takes it, so the sidecar has the
   * working text and the review, and the next load of the document attaches
   * them (#146).
   */
  private _holdsUndecidedProposal(document: Document): boolean {
    return this._reviewApplication.getStatus(document.documentId)?.state === "active";
  }

  /**
   * Of `documents`, the ones whose unsaved text a prompt asks the author to
   * save or discard: a modified document that holds no undecided proposal.
   * A document with a frozen review is asked about only while a pane shows
   * it; `_reviewedDocumentsWithoutPane` parks the others.
   */
  private _documentsToAskAbout(documents: readonly Document[]): Document[] {
    const shown = this._pathsShownInPanes();
    return documents.filter((document) => {
      if (!this.isModified(document.filePath) || this._holdsUndecidedProposal(document)) {
        return false;
      }
      const state = this._reviewApplication.getStatus(document.documentId)?.state;
      return state !== "invalidated" || shown.has(document.filePath);
    });
  }

  /**
   * An agent proposal loads its document into the authority without a pane,
   * and the review's working text leaves that buffer modified where nobody is
   * looking at it. The sidecar is where a closed document's review lives, so
   * a quit detaches these the way closing their last tab would. A document
   * whose proposals the author all decided on is not here: its unsaved text
   * is text of the author, and the quit asks about it.
   */
  private _reviewedDocumentsWithoutPane(): Document[] {
    const shown = this._pathsShownInPanes();
    const asked = new Set(this._documentsToAskAbout(this.documents));
    return this.documents.filter(
      (document) =>
        !shown.has(document.filePath) &&
        !asked.has(document) &&
        this._reviewApplication.getReview(document.documentId) !== undefined,
    );
  }

  /**
   * Whether a quit has work to do before the process may end: a review to
   * park or a question for the author. The window provider keeps the last
   * window open exactly while this holds.
   */
  public settlesBeforeQuit(): boolean {
    return (
      this._reviewedDocumentsWithoutPane().length > 0 ||
      this._documentsToAskAbout(this.documents).length > 0
    );
  }

  /**
   * Tells the author something about one document, in one place. The window
   * that started the action gets the message. An event that no window
   * started (a quit, a change on disk, an autosave) goes to each window
   * whose panes show the document. The window provider gives the message to
   * the main window that the author used last when none of those can show
   * it.
   */
  private _tellAbout(
    filePath: string,
    startedBy: string | undefined,
    channel: string,
    payload: DocumentMessage,
  ): void {
    const addressed =
      startedBy !== undefined
        ? [startedBy]
        : Object.entries(this._windows)
            .filter(([, tree]) =>
              tree
                .getAllLeafs()
                .some((leaf) => leaf.tabMan.openFiles.some((file) => file.path === filePath)),
            )
            .map(([windowId]) => windowId);
    this._app.windows.tellMainWindows(addressed, channel, payload);
  }

  private _pathsShownInPanes(): Set<string> {
    return new Set(
      Object.values(this._windows).flatMap((tree) =>
        tree.getAllLeafs().flatMap((leaf) => leaf.tabMan.openFiles.map((file) => file.path)),
      ),
    );
  }

  /**
   * Park every reviewed document no pane shows, then ask about the rest by
   * name. Resolves true when the quit may proceed. A detach or save that
   * fails keeps the app open and announces why, as a window close does.
   */
  private async _settleDocumentsBeforeQuit(
    parked: Document[],
    unsaved: Document[],
  ): Promise<boolean> {
    for (const document of parked) {
      const detached = await this._detachForClose(
        document.documentId,
        document.filePath,
        async () => {
          app.quit();
        },
        "quit",
      );
      if (!detached) {
        return false;
      }
      this._unload(document);
    }
    if (parked.length > 0) {
      this.syncWatchedFilePaths();
    }
    if (unsaved.length === 0) {
      return true;
    }

    const opt: MessageBoxOptions = {
      type: "question",
      buttons: [trans("Save changes"), trans("Discard changes"), trans("Cancel")],
      defaultId: 0,
      cancelId: 2,
      title: trans("Unsaved changes"),
      message: trans("There are unsaved changes. Do you want to save or discard them?"),
      detail: this._quitPromptDetail(unsaved),
    };
    const { response } = await dialog.showMessageBox(opt);
    // 0 = Save, 1 = Don't save, 2 = Cancel
    if (response === 2) {
      this._app.log.verbose("User cancelled save-dialog; not quitting.");
      return false;
    }
    for (const document of unsaved) {
      if (response === 0) {
        const saved = await this.saveFile(document.filePath);
        if (!saved.ok) {
          this._announceSaveRefusal(document.filePath, saved);
          return false;
        }
      } else if (
        !(await this._discardForClose(
          document,
          async () => {
            app.quit();
          },
          "quit",
        ))
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * The documents that the quit prompt asks about, one path for each line.
   * A modified document in a pane that the prompt does not ask about is
   * named after them with the reason, so the author knows where its text is.
   */
  private _quitPromptDetail(unsaved: Document[]): string {
    const shown = this._pathsShownInPanes();
    const kept = this.documents.filter(
      (document) =>
        shown.has(document.filePath) &&
        this.isModified(document.filePath) &&
        this._holdsUndecidedProposal(document),
    );
    const asked = unsaved.map((document) => document.filePath).join("\n");
    if (kept.length === 0) {
      return asked;
    }
    const keptPaths = kept.map((document) => document.filePath).join("\n");
    return `${asked}\n\n${trans("Not saved and not discarded, because a review has open proposals. The text and the review return at the next start:")}\n${keptPaths}`;
  }

  /**
   * Use this method to ask the user whether or not the window identified with
   * the windowId may be closed. If this function returns true, the user agreed
   * to drop all changes, or there were no changes contained in the window.
   *
   * @param   {string}            windowId    The window in question
   * @param   {Function}          closeAgain  Repeats the close of the window (closeWindow)
   *
   * @return  {Promise<boolean>}              Returns false if the window may not be closed
   */
  public async askUserToCloseWindow(
    windowId: string,
    closeAgain: () => Promise<void>,
  ): Promise<boolean> {
    if (this.isClean(windowId)) {
      return true;
    }

    // A document that holds an undecided proposal is neither saved nor
    // discarded here: closeWindow puts its text and its review in the sidecar.
    const asked = this._documentsToAskAbout(this._windowExclusiveDocuments(windowId));
    if (asked.length === 0) {
      return await this.closeWindow(windowId, closeAgain);
    }

    const result = await this._app.windows.askSaveChanges();
    // 0 = Save, 1 = Don't save, 2 = Cancel
    if (result.response === 1) {
      // Discard, which is what the button says: the buffers go back to their
      // disk bytes and every review over the discarded text is destroyed.
      // Marking them clean and keeping the text was the older behaviour; a
      // pane in another window then still showed the omitted edit, and a
      // review's sidecar reattached it after the next restart.
      //
      // Only this window's documents: the prompt named this window's unsaved
      // changes, and a discard that reached every loaded document would throw
      // away edits the user is still holding in another window.
      for (const document of asked) {
        if (!(await this._discardForClose(document, closeAgain, "close", windowId))) {
          return false;
        }
      }

      // If we're not shutting down, this function will only be called for when
      // the user wants to actively close a window for good
      return await this.closeWindow(windowId, closeAgain);
    } else if (result.response === 0) {
      // Save this window's docs — the same set the discard branch throws away.
      for (const document of asked) {
        const saved = await this.saveFile(document.filePath);
        if (!saved.ok) {
          this._announceSaveRefusal(document.filePath, saved, windowId);
          return false;
        }
      }

      // If we're not shutting down, this function will only be called for when
      // the user wants to actively close a window for good
      return await this.closeWindow(windowId, closeAgain);
    } else {
      return false;
    }
  }

  async boot(): Promise<void> {
    // Loads in all openFiles
    this._app.log.verbose("Document Manager starting up ...");

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
            // A failed access check gives no answer. The tab stays, and the
            // document reports the error of the file when it loads.
            const gone = await this._app.fsal
              .testAccess(file, FSConstants.F_OK | FSConstants.W_OK | FSConstants.R_OK)
              .then(
                (accessible) => !accessible,
                (err: Error) => {
                  this._app.log.error(
                    `[Document Provider] Could not test the access to ${file}: ${err.message}`,
                    err,
                  );
                  return false;
                },
              );
            if (gone) {
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
    this.startDatabaseSynchronization();
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

  /**
   * Removes a window from the provider. Resolves false when the window
   * must stay: the collaboration state of one of its documents could not
   * be written (_detachForClose). `closeAgain` is the request of the
   * window owner that repeats this close.
   */
  public async closeWindow(windowId: string, closeAgain: () => Promise<void>): Promise<boolean> {
    if (this._shuttingDown) {
      return true; // During shutdown only the WindowManager should close windows
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
      // An editor of the window can load a document again while a later
      // document detaches (pullUpdates), so the window goes only when none
      // of its documents is loaded.
      let exclusive = this._windowExclusiveDocuments(windowId);
      while (exclusive.length > 0) {
        for (const document of exclusive) {
          const detached = await this._detachForClose(
            document.documentId,
            document.filePath,
            closeAgain,
            "close",
            windowId,
          );
          if (!detached) {
            return false;
          }
          this._unload(document);
        }
        exclusive = this._windowExclusiveDocuments(windowId);
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._windows[windowId];
      this._closedTabs.delete(windowId);
      this.syncToConfig();
      this.syncWatchedFilePaths();
    }
    return true;
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
    await this._config.shutdown();
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
    // A load adds the document before it reattaches the sidecar, so a
    // request during a load waits for that load instead of reading the
    // document half-loaded or loading it a second time.
    const pendingLoad = this._pendingLoads.get(filePath);
    if (pendingLoad !== undefined) {
      await pendingLoad;
    }
    const existingDocument = this.documents.find((doc) => doc.filePath === filePath);
    if (existingDocument !== undefined) {
      return {
        content: existingDocument.document.toString(),
        type: existingDocument.type,
        startVersion: existingDocument.currentVersion,
      };
    }

    const load = this._loadDocument(filePath);
    this._pendingLoads.set(filePath, load);
    try {
      return await load;
    } finally {
      this._pendingLoads.delete(filePath);
    }
  }

  private async _loadDocument(
    filePath: string,
  ): Promise<{ content: string; type: DocumentType; startVersion: number }> {
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

    // Reattachment: a sidecar for this path means a review detached here.
    // On a verified fence this restores the buffer to the review's working
    // text, so the content and version returned must be read AFTER it.
    await this._reattachCollaborationSidecar(doc);

    // The authority loaded a markdown buffer: feed the references provider's
    // live overlay (issue #53). Reporting on LOAD — not only on the first
    // edit — means an open document's occurrences are part of the merged
    // reference view even when FSAL never indexed the file, and a load is
    // a single event, so it skips the typing debounce (issue #46).
    if (doc.type === DocumentType.Markdown) {
      this._app.references.reportAuthorityBuffer(filePath, true);
    }

    return {
      content: doc.document.toString(),
      type,
      startVersion: doc.currentVersion,
    };
  }

  /**
   * Load the authority buffer a proposal needs, without opening a pane.
   *
   * A proposal is defined against a live buffer, so submitting one against a
   * closed workspace file has to load it. `getDocument` is the primitive that
   * does exactly that and no more: it populates the authority, reattaches any
   * sidecar the path carries, and creates no renderer view — so the load
   * changes nothing the user can see until the review it carries commits.
   *
   * `wasAlreadyLoaded` is what a refused submission needs: only a buffer this
   * acquisition brought in may be released again. `undefined` means the id
   * names no path at all, which the submission below refuses on its own.
   */
  public async acquireDocument(documentId: string): Promise<{
    documentId: string;
    documentPath: string;
    wasAlreadyLoaded: boolean;
  }> {
    const documentPath = this.getDocumentPath(documentId);
    if (documentPath === undefined) {
      throw new Error(`Cannot acquire document ${documentId}: no path is registered for it`);
    }
    const wasAlreadyLoaded = this.documents.some((doc) => doc.filePath === documentPath);
    if (!wasAlreadyLoaded) {
      await this.getDocument(documentPath);
    }
    return { documentId, documentPath, wasAlreadyLoaded };
  }

  /**
   * Undo an acquisition that a refused proposal no longer justifies.
   *
   * A submission that commits nothing must not leave the editor holding a
   * document nobody opened, so the buffer it acquired goes back out. The
   * unload is non-destructive by construction: a document that gained an
   * editor view, unsaved changes, or a review has an owner beyond this
   * acquisition, and it is left exactly as it is.
   */
  public async releaseTemporaryDocument(documentId: string): Promise<boolean> {
    const filePath = this.getDocumentPath(documentId);
    if (filePath === undefined) {
      return false;
    }
    const doc = this.documents.find((candidate) => candidate.filePath === filePath);
    if (doc === undefined || doc.currentVersion !== doc.lastSavedVersion) {
      return false;
    }
    if (this._reviewApplication.getReview(documentId) !== undefined) {
      return false;
    }

    let hasEditorView = false;
    await this.forEachLeaf(async (tabMan) => {
      if (tabMan.openFiles.some((openFile) => openFile.path === filePath)) {
        hasEditorView = true;
      }
      return false;
    });
    if (hasEditorView) {
      return false;
    }

    this._unload(doc);
    this.syncWatchedFilePaths();
    return true;
  }

  private async pullUpdates(
    filePath: string,
    clientVersion: number,
  ): Promise<SerializedUpdate[] | false> {
    const doc = this.documents.find((doc) => doc.filePath === filePath);
    if (doc === undefined) {
      // The editor of a pane gets the document again: the document was
      // unloaded while the pane shows it. An editor whose pane is gone (its
      // window closes) has nothing to get. A load for it would leave a
      // document that no window shows, with the review of its sidecar.
      return this._pathsShownInPanes().has(filePath) ? false : [];
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

  /**
   * Accept an editor's collab updates into the authority buffer.
   *
   * While a review is open this is a STAGED commit: the incoming changes are
   * applied to a local candidate, suggestion anchors are mapped through the
   * transaction, and the resulting sidecar is written BEFORE the document
   * takes any of it. Persistence failure leaves `doc.document`, the versions,
   * the update history and the review exactly as they were, and rejects the
   * call — the renderer's update stays unsent and is retried.
   *
   * That is what makes an acknowledgment mean something: a `true` answer here
   * says the reviewed buffer is already on disk, not that it will be.
   */
  private async pushUpdates(
    filePath: string,
    clientVersion: number,
    clientUpdates: SerializedUpdate[],
  ): Promise<boolean> {
    this._lastEditorInputAt = Date.now();
    return this._reviewApplication.withDocumentLock(
      this.ensureDocumentId(filePath),
      async () => await this.pushUpdatesLocked(filePath, clientVersion, clientUpdates),
    );
  }

  /**
   * The time (epoch milliseconds) of the last update that an editor sent to
   * this authority, and 0 when no editor sent one. Background work that takes
   * processor time from the window waits on it (the lint queue, #139).
   */
  public lastEditorInputAt(): number {
    return this._lastEditorInputAt;
  }

  private async pushUpdatesLocked(
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

    // The candidate document: everything the updates produce, computed
    // without touching the authority's own state.
    let candidateText = doc.document;
    let candidateChanges = ChangeSet.empty(doc.document.length);
    for (const update of clientUpdates) {
      try {
        const changes = ChangeSet.fromJSON(update.changes);
        candidateText = changes.apply(candidateText);
        candidateChanges = candidateChanges.compose(changes);
      } catch (err: unknown) {
        dialog.showErrorBox(
          "Document out of sync",
          `Your modifications could not be applied to the document in memory.
This means that saving might fail. Please report this bug to us, copy the
current contents from the editor somewhere else, and restart the application.`,
        );
        throw err;
      }
    }
    const candidateUpdates = [...doc.updates, ...clientUpdates];
    let candidateMinimumVersion = doc.minimumVersion;
    let candidateVersion = candidateMinimumVersion + candidateUpdates.length;
    // People are lazy, and hence there is a non-zero chance that in a few
    // instances the currentVersion will get dangerously close to
    // Number.MAX_SAFE_INTEGER. In that case, we need to perform a rollback to
    // version 0 and notify all editors that have the document in question
    // open to simply re-load it. That will cause a screen-flicker, but
    // honestly better like this than otherwise.
    if (candidateVersion >= Number.MAX_SAFE_INTEGER - 1) {
      console.warn(`Document ${filePath} has reached MAX_SAFE_INTEGER. Performing rollback ...`);
      candidateMinimumVersion = 0;
      candidateVersion = candidateUpdates.length;
      // TODO: Broadcast a message so that all editor instances can reload the
      // document.
    }
    // Drop all updates that exceed the amount of updates we allow.
    while (candidateUpdates.length > MAX_VERSION_HISTORY) {
      candidateUpdates.shift();
      candidateMinimumVersion += 1;
    }

    const documentId = this.ensureDocumentId(filePath);
    const reviewed = this._reviewApplication.getReview(documentId) !== undefined;
    const candidateWorkingText = normalizeText(candidateText.toString());
    const commitDocument = (): void => {
      doc.document = candidateText;
      doc.updates = candidateUpdates;
      doc.minimumVersion = candidateMinimumVersion;
      doc.currentVersion = candidateVersion;
      this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
        filePath,
        status: "modification",
      });
      if (doc.type === DocumentType.Markdown) {
        this._app.references.reportAuthorityBuffer(filePath);
      }
    };

    // The collaboration service commits the document. A document with a
    // review or with annotations gets its sidecar first: the service maps
    // the suggestions and the annotation anchors through the changes. A
    // document with neither is committed at once.
    await this._reviewApplication.applyWorkingTextEditLocked(
      documentId,
      candidateWorkingText,
      candidateChanges,
      commitDocument,
    );
    if (reviewed) {
      // A reviewed document does not autosave: the save gate owns when its
      // bytes reach disk.
      return true;
    }

    const autoSave = this._app.config.get().editor.autoSave;

    // No autosave
    if (autoSave === "off") {
      return true;
    }

    doc.saveTimeout = setTimeout(() => {
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
          // A failed disk write leaves the text only in memory, so the user
          // learns of it now, through the same toast as a refused close.
          if (result.refusal.reason === "write-failed") {
            const payload: SaveRefusedBroadcast = {
              filePath: doc.filePath,
              refusal: result.refusal,
            };
            this._tellAbout(doc.filePath, undefined, SAVE_REFUSED_CHANNEL, payload);
          }
          const reason = `${result.refusal.reason}: ${result.refusal.message}`;
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
    }, autoSaveDelayMs[autoSave]);

    return true;
  }

  // END DOCUMENT AUTHORITY FUNCTIONS

  /**
   * Names to the citation provider the bibliographies that it keeps: those
   * of the loaded documents and those of the Quarto books of the loaded
   * roots. Ends when the provider read each of them; a file that does not
   * load is a problem of the provider and rejects nothing here.
   *
   * The calls name their bibliographies in the order of the calls, so the
   * last call decides what the provider keeps. A root-management command
   * waits for this after it changed the roots: the bibliographies of a new
   * root are then available to the editors that are open.
   */
  public async synchronizeDatabases(): Promise<void> {
    const named = this.bibliographiesNamed.then(async () => {
      const libraries = await this.bibliographies();
      return { read: this._app.citeproc.synchronizeDatabases(libraries) };
    });
    // The next call collects after this one, also when this one failed.
    this.bibliographiesNamed = named.then(
      () => {},
      () => {},
    );
    await (await named).read;
  }

  /**
   * Names the bibliographies again and does not wait for the reads. The
   * start, and an open, a close and a save of a document do not wait for a
   * library: the read of a large one takes seconds.
   */
  private startDatabaseSynchronization(): void {
    this.synchronizeDatabases().catch((err: unknown) => {
      this._app.log.error(
        `[Document Manager] Could not name the bibliographies to the citation provider: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    });
  }

  /**
   * The absolute paths of the bibliographies of the Quarto books of the
   * loaded roots and of the loaded documents. The documents are read last and
   * without a wait after them, so the list has the documents of the moment
   * at which the citation provider gets it.
   */
  private async bibliographies(): Promise<string[]> {
    const libraries = new Set<string>();

    if (typeof this._app.fsal.getAllLoadedDescriptors === "function") {
      for (const descriptor of await this._app.fsal.getAllLoadedDescriptors()) {
        if (
          descriptor.type === "directory" &&
          descriptor.settings.project?.manifest.kind === "quarto"
        ) {
          for (const bibPath of descriptor.settings.project.manifest.bibliographies) {
            if (path.isAbsolute(bibPath)) {
              libraries.add(bibPath);
            }
          }
        }
      }
    }

    // The main library is the provider's own; '' leaves it out of the list.
    const ofDocuments = await Promise.all(
      [...this.documents].map(
        async (doc) =>
          (await documentBibliography(this._app.fsal, doc.filePath, doc.document.toString()))
            .database,
      ),
    );
    for (const database of ofDocuments) {
      for (const file of bibliographyFiles(database, "")) {
        libraries.add(file);
      }
    }

    return [...libraries];
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
  /**
   * Opens a path with the application of the desktop. The open of a
   * document does not wait for that application; a refusal is a message
   * of its own.
   */
  private _openExternally(filePath: string): void {
    openPath(filePath).catch((refusal: Error) => {
      this._app.log.error(refusal.message, refusal);
      this._app.windows.showErrorMessage(trans("Could not open the file"), refusal.message);
    });
  }

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
        this._openExternally(filePath);
        return false;
      }

      // Else: Whatever this is, it was not a proper path.
      throw new Error(`Could not open file ${filePath}: Not an existing file.`);
    }

    // A file that Zettlr cannot or must not open goes to the shell, which
    // opens it externally. NOTE: This check is, to varying
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
        this._openExternally(filePath);
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
    if (!openFiles.includes(filePath) && innermostRoot(filePath, openWorkspaces) === undefined) {
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
    this.startDatabaseSynchronization();
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
    const repeatClose = async (): Promise<void> => {
      await this.closeFile(windowId, leafId, filePath);
    };
    // The window of the tab shows a refusal of this close.
    const detachForThisClose = async (): Promise<boolean> =>
      openFile !== undefined &&
      (await this._detachForClose(openFile.documentId, filePath, repeatClose, "close", windowId));
    if (openFile !== undefined && this.isModified(filePath) && numOpenInstances === 1) {
      const detail = trans("File: %s", openFile.descriptor.name);
      const result = await this._app.windows.askSaveChanges(detail);
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 1) {
        if (!(await this._discardForClose(openFile, repeatClose, "close", windowId))) {
          return false;
        }
        // A saved review may survive the discard of a later edit. The
        // document is about to leave the live registry, so detach that
        // preserved review before removing its working-text resolver.
        if (!(await detachForThisClose())) {
          return false;
        }
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
          filePath,
          status: "modification",
        });
      } else if (result.response === 0) {
        const saved = await this.saveFile(filePath);
        if (!saved.ok) {
          this._announceSaveRefusal(filePath, saved, windowId);
          return false;
        }
        // The save persists the review, but the final pane is leaving the
        // live registry. Detach before the splice so closed-file API reads do
        // not observe a review whose working-text authority is gone.
        if (!(await detachForThisClose())) {
          return false;
        }
      } else {
        // Don't close the file
        this._app.log.info("[Document Manager] Not closing file, as the user did not want that.");
        return false;
      }

      // Remove the file
      this._unload(openFile);
    } else if (openFile !== undefined && numOpenInstances === 1) {
      // The file is not modified, but this is still the last instance, so we
      // can close it without having to ask. Detach before the splice: the
      // sidecar export reads the working text through the live document.
      if (!(await detachForThisClose())) {
        return false;
      }
      this._unload(openFile);
    }

    const ret = leaf.tabMan.closeFile(filePath);
    if (ret) {
      let history = this._closedTabs.get(windowId);
      if (history === undefined) {
        history = [];
        this._closedTabs.set(windowId, history);
      }
      history.push(filePath);
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

      this.startDatabaseSynchronization();
    }
    return ret;
  }

  public async reopenClosedTab(windowId: string): Promise<boolean> {
    const history = this._closedTabs.get(windowId);
    if (history === undefined || history.length === 0) {
      return false;
    }
    const filePath = history[history.length - 1];
    const reopened = await this.openFile(windowId, undefined, filePath, true);
    if (reopened) {
      history.pop();
    }
    return reopened;
  }

  /**
   * Close every tab in one window, or in one pane of it when `leafId` is
   * given, using the ordinary per-document close path. The Window menu and
   * the context menu of a tab are this one action (#202).
   *
   * Modified documents therefore keep the existing Save / Don't save / Cancel
   * semantics. Pinned tabs are included because "all tabs" is explicit, but a
   * refused/cancelled close restores the pin before aborting the bulk action.
   */
  public async closeAllTabs(windowId: string, leafId?: string): Promise<boolean> {
    const tree = this._windows[windowId];
    if (tree === undefined) {
      return false;
    }
    const leafs = tree.getAllLeafs().filter((leaf) => leafId === undefined || leaf.id === leafId);
    const tabs = leafs.flatMap((leaf) =>
      leaf.tabMan.openFiles.map((file) => ({
        leafId: leaf.id,
        path: file.path,
        pinned: file.pinned,
      })),
    );

    for (const tab of tabs) {
      const leaf = this._windows[windowId]?.findLeaf(tab.leafId);
      if (leaf === undefined) {
        continue;
      }
      if (tab.pinned) {
        leaf.tabMan.setPinnedStatus(tab.path, false);
      }
      const closed = await this.closeFile(windowId, tab.leafId, tab.path);
      if (!closed) {
        const currentLeaf = this._windows[windowId]?.findLeaf(tab.leafId);
        if (tab.pinned && currentLeaf !== undefined) {
          currentLeaf.tabMan.setPinnedStatus(tab.path, true);
        }
        return false;
      }
    }
    return true;
  }

  /**
   * Save every modified document represented in a window. The first refused
   * save is announced and stops the run; it returns false.
   */
  public async saveAll(windowId: string): Promise<boolean> {
    if (!(windowId in this._windows)) {
      return false;
    }
    for (const document of this._windowDocuments(windowId)) {
      if (!this.isModified(document.filePath)) {
        continue;
      }
      const saved = await this.saveFile(document.filePath);
      if (!saved.ok) {
        this._announceSaveRefusal(document.filePath, saved, windowId);
        return false;
      }
    }
    return true;
  }

  /**
   * Save every modified document represented in a window, then close all of
   * its tabs. Since the buffers are clean before closing, ordinary unsaved-file
   * prompts are bypassed. A refused save aborts before any tab is closed.
   */
  public async saveAllAndClose(windowId: string): Promise<boolean> {
    if (!(await this.saveAll(windowId))) {
      return false;
    }
    return await this.closeAllTabs(windowId);
  }

  /**
   * Directs every open leaf to close a given file. This function even
   * overwrites potential stati such as modification or pinned to ensure files
   * are definitely closed. This will be called from within the watcher callback
   * on an `unlink` event.
   *
   * Resolves false when the collaboration state could not be written: the
   * document stays loaded and its tabs stay open, so the refusal that the
   * window shows is true and the author still has the buffer. A caller that
   * removes the file afterwards must stop on false.
   *
   * @param   {string}  filePath  The file path in question
   */
  public async closeFileEverywhere(filePath: string): Promise<boolean> {
    // Detach before the tabs close and before the splice: the sidecar export
    // reads the working text through the live document. After an `unlink`
    // the file is gone from disk, so the review in memory and the buffer are
    // the only copy of both.
    const documentId = this.getDocumentId(filePath);
    if (
      documentId !== undefined &&
      !(await this._detachForClose(documentId, filePath, async () => {
        await this.closeFileEverywhere(filePath);
      }))
    ) {
      return false;
    }
    await this._closeTabsEverywhere(filePath);
    const document = this.documents.find((doc) => doc.filePath === filePath);
    if (document !== undefined) {
      this._unload(document);
    }

    this.syncWatchedFilePaths();
    return true;
  }

  /**
   * Closes each document at or inside `targetPath` before a delete in the
   * application removes its file: each loaded document and each tab. Unsaved
   * text is asked about for each document. Resolves false at the first
   * document that stays open: the author cancelled, or its close was refused.
   */
  public async closeDocumentsForDelete(targetPath: string): Promise<boolean> {
    const paths = new Set([
      ...this.documents.map((document) => document.filePath),
      ...this._pathsShownInPanes(),
    ]);
    for (const filePath of paths) {
      if (isAtOrInsideRoot(filePath, targetPath) && !(await this.closeFileEverywhere(filePath))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Moves aside the collaboration state of each document at or inside
   * `deletedPath`, after the author deleted that path in the application. A
   * new file at the path of a deleted document does not get its annotations
   * or its review; the bytes stay in the sidecar directory. A document that
   * is loaded keeps its state. A sidecar that cannot be read is moved aside
   * when it is the one of `deletedPath`; the name of the file of another
   * document is a hash that names no path.
   */
  public async setAsideStateOfDeleted(deletedPath: string): Promise<void> {
    const loaded = new Set(this.documents.map((document) => document.filePath));
    const { sidecars, unreadable } = await this._reviewApplication.collaborationSidecarInventory();
    const files = sidecars
      .filter(
        (sidecar) =>
          isAtOrInsideRoot(sidecar.documentPath, deletedPath) && !loaded.has(sidecar.documentPath),
      )
      .map((sidecar) => this._reviewApplication.sidecarFileOf(sidecar.documentPath));
    const ownFile = this._reviewApplication.sidecarFileOf(deletedPath);
    if (unreadable.some((entry) => entry.file === ownFile)) {
      files.push(ownFile);
    }
    for (const file of files) {
      await this._reviewApplication.setAsideCollaborationSidecar(file);
    }
  }

  /**
   * Closes each document at or inside one of `rootPaths` that no other open
   * root holds: each loaded document and each tab, also of a path that the
   * file filters hide. A document of a workspace that stays open stays open
   * with its text. Unsaved text is
   * asked about one time, as at the close of a window; a document with an
   * undecided proposal is not asked about, its close puts the review in the
   * sidecar. Resolves false when a document stays open: the author
   * cancelled, a save was refused, or a close was refused with an action
   * that runs `closeAgain`.
   */
  public async closeDocumentsInside(
    rootPaths: readonly string[],
    closeAgain: () => Promise<void>,
  ): Promise<boolean> {
    const { openFiles, openWorkspaces } = this._app.config.get().app;
    const otherRoots = [...openFiles, ...openWorkspaces].filter(
      (root) => !rootPaths.includes(root),
    );
    const inside = (filePath: string): boolean =>
      rootPaths.some((root) => isAtOrInsideRoot(filePath, root)) &&
      !otherRoots.some((root) => isAtOrInsideRoot(filePath, root));
    const loaded = this.documents.filter((document) => inside(document.filePath));
    const asked = this._documentsToAskAbout(loaded);
    if (asked.length > 0) {
      const detail = asked
        .map((document) => trans("File: %s", document.descriptor.name))
        .join("\n");
      const result = await this._app.windows.askSaveChanges(detail);
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 2) {
        return false;
      }
      for (const document of asked) {
        if (result.response === 1) {
          if (!(await this._discardForClose(document, closeAgain, "close"))) {
            return false;
          }
          continue;
        }
        const saved = await this.saveFile(document.filePath);
        if (!saved.ok) {
          this._announceSaveRefusal(document.filePath, saved);
          return false;
        }
      }
    }
    const paths = new Set([
      ...loaded.map((document) => document.filePath),
      ...[...this._pathsShownInPanes()].filter(inside),
    ]);
    for (const filePath of paths) {
      if (!(await this.closeFileEverywhere(filePath))) {
        return false;
      }
    }
    return true;
  }

  /** Closes the tab of a path in every pane, pinned or not. */
  private async _closeTabsEverywhere(filePath: string): Promise<void> {
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
  }

  /**
   * Every Markdown and code file of the workspace at `workspacePath`, by the
   * walk of the FSAL, and each folder whose content that walk does not hold.
   */
  public async getFilesForWorkspace(
    workspacePath: string,
  ): Promise<{ files: string[]; notListed: FolderNotListed[] }> {
    const listing = await this._app.fsal.readDirectoryRecursively(workspacePath);
    return {
      files: listing.paths.filter((p) => p !== workspacePath && hasMdOrCodeExt(p) && !isDir(p)),
      notListed: listing.notListed,
    };
  }

  /** Tells the author that a removed file left a document with unsaved text. */
  private _announceRemovedFileKept(filePath: string): void {
    const documentId = this.getDocumentId(filePath);
    const payload: FileRemovedKeptBroadcast = {
      filePath,
      saveWritesFile:
        documentId === undefined || this._reviewApplication.getReview(documentId) === undefined,
    };
    this._app.log.warning(
      `[DocumentManager] ${filePath} was removed from disk; its document has unsaved text and stays open.`,
    );
    this._tellAbout(filePath, undefined, FILE_REMOVED_KEPT_CHANNEL, payload);
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
      await this._reviewApplication.invalidateOnDiskDrift(_docId);
    }

    const isModified = doc.lastSavedVersion !== doc.currentVersion;
    const { alwaysReloadFiles } = this._app.config.get();
    if (isModified || !alwaysReloadFiles) {
      // The buffer has unsaved changes, or the user does not reload changes
      // automatically. The editor keeps its contents, which now differ from
      // the disk, and the renderer offers to load the disk version.
      if ((this._announcedRemoteModtime.get(filePath) ?? -Infinity) >= modtime) {
        return;
      }
      this._announcedRemoteModtime.set(filePath, modtime);
      doc.lastSavedVersion--;
      this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
        filePath,
        status: "modification",
      });
      const payload: RemoteChangeKeptBroadcast = { filePath, unsavedChanges: isModified };
      this._tellAbout(filePath, undefined, REMOTE_CHANGE_KEPT_CHANNEL, payload);
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
    if (oldPath === newPath) {
      return;
    }
    await this._dropReplacedDocument(newPath);

    // The document keeps its id, loaded or not: its annotations, its review
    // and the agents that hold the id follow it to the new path (#178).
    const documentId = this._assignDocumentId(oldPath);
    await this._reviewApplication.withDocumentLock(documentId, async () => {
      this._movePathOfDocument(documentId, oldPath, newPath);
      // The sidecar goes last. When it cannot be written, the error goes to
      // the caller with the id, the tabs and the state in memory at the new
      // path: the next write of the state lands there.
      await this._reviewApplication
        .renameCollaboration(documentId, oldPath, newPath)
        .catch((failure: Error) => {
          throw ReviewStateNotMovedError.of(newPath, failure);
        });
    });
  }

  /**
   * A move put another file at this path. The document that was there lost
   * its file: its tabs close, and its buffer and its collaboration state in
   * memory go with no write. The move of the sidecar replaces its sidecar.
   */
  private async _dropReplacedDocument(filePath: string): Promise<void> {
    await this._closeTabsEverywhere(filePath);
    const replacedId = this.getDocumentId(filePath);
    if (replacedId !== undefined) {
      await this._reviewApplication.withDocumentLock(replacedId, async () => {
        this._reviewApplication.dropCollaboration(replacedId);
      });
    }
    const replaced = this.documents.find((doc) => doc.filePath === filePath);
    if (replaced !== undefined) {
      this._unload(replaced);
    }
  }

  /**
   * Every record of the provider that names the path of a document takes
   * the new path, in one synchronous step: the id maps, the loaded
   * document, the reference overlay, the tabs and the watcher.
   */
  private _movePathOfDocument(documentId: string, oldPath: string, newPath: string): void {
    this._moveDocumentId(documentId, oldPath, newPath);
    this._announcedRemoteModtime.delete(oldPath);
    this._announcedRemoteModtime.delete(newPath);

    const openDoc = this.documents.find((doc) => doc.filePath === oldPath);
    if (openDoc !== undefined) {
      openDoc.filePath = newPath;
      openDoc.descriptor.path = newPath;
      openDoc.descriptor.dir = path.dirname(newPath);
      openDoc.descriptor.name = path.basename(newPath);
      openDoc.descriptor.ext = path.extname(newPath);

      // The buffer moved with the document: its live reference overlay moves
      // too (issue #53) — the old path's overlay dies, the new path reports
      // immediately (a move is a single event, not a typing storm).
      this._app.references.dropAuthorityBuffer(oldPath);
      if (openDoc.type === DocumentType.Markdown) {
        this._app.references.reportAuthorityBuffer(newPath, true);
      }
    }

    const leafsToNotify: Array<[string, string]> = [];
    let tabsChanged = false;
    for (const [windowId, tree] of Object.entries(this._windows)) {
      for (const leaf of tree.getAllLeafs()) {
        if (leaf.tabMan.replaceFilePath(oldPath, newPath)) {
          leafsToNotify.push([windowId, leaf.id]);
          tabsChanged = true;
        }
      }
    }
    if (tabsChanged) {
      this.syncToConfig();
    }

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
   * Each document of the folder moves, also after the move of another
   * failed. The documents whose collaboration state stayed at the old path
   * are one error (ReviewStateNotMovedError).
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The new path
   */
  public async hasMovedDir(oldPath: string, newPath: string): Promise<void> {
    // Similar as hasMovedFile, but triggers the command for every affected
    // file: each loaded document, each path with an id and each tab below
    // the folder, then each document that has only a sidecar.
    const known = new Set(
      [
        ...this.documents.map((doc) => doc.filePath),
        ...this._documentIdByPath.keys(),
        ...this._pathsShownInPanes(),
      ].filter((filePath) => isInsideRoot(filePath, oldPath)),
    );
    const failures: Error[] = [];
    const move = async (filePath: string): Promise<void> => {
      await this.hasMovedFile(filePath, newPath + filePath.slice(oldPath.length)).catch(
        (failure: Error) => {
          failures.push(failure);
        },
      );
    };
    for (const filePath of known) {
      this._app.log.info(`Replacing file path for doc ${filePath} with one in ${newPath}`);
      await move(filePath);
    }

    // A file that cannot be read stays where it is. It stops no move. A
    // document of the first loop whose sidecar stayed at the old path is
    // not moved a second time: that move would replace the document.
    const { sidecars } = await this._reviewApplication.collaborationSidecarInventory();
    for (const sidecar of sidecars) {
      if (isInsideRoot(sidecar.documentPath, oldPath) && !known.has(sidecar.documentPath)) {
        await move(sidecar.documentPath);
      }
    }

    const stateStayed = failures.filter((failure) => failure instanceof ReviewStateNotMovedError);
    throwFailures([
      ...(stateStayed.length > 1 ? [ReviewStateNotMovedError.merged(stateStayed)] : stateStayed),
      ...failures.filter((failure) => !(failure instanceof ReviewStateNotMovedError)),
    ]);
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
    // Detach before the splice: the sidecar export reads the working text
    // through the live document. After external drift the review arrives
    // here invalidated, and it is stored frozen until it is reapplied or
    // discarded.
    // The reload is what would discard the in-memory review, so it does not
    // happen when the detach fails: the buffer and the review stay, and the
    // renderer is told why the file it saw change was not reloaded.
    const documentId = this.getDocumentId(filePath);
    if (
      documentId !== undefined &&
      !(await this._detachForClose(
        documentId,
        filePath,
        async () => {
          await this.notifyRemoteChange(filePath);
        },
        "reload",
      ))
    ) {
      return;
    }
    // The reloading renderers re-trigger getDocument, which reports the
    // fresh buffer; until then the saved FSAL snapshot is the truth.
    const document = this.documents.find((file) => file.filePath === filePath);
    if (document !== undefined) {
      this._unload(document);
    }
    this._announcedRemoteModtime.delete(filePath);
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
   * Returns the path of the active file of a leaf.
   * @returns {string|undefined} The path, or undefined when the leaf does not
   *                             exist or has no active file.
   */
  public getActiveFile(leafId: string): string | undefined {
    for (const windowId in this._windows) {
      const leaf = this._windows[windowId].findLeaf(leafId);
      if (leaf !== undefined) {
        return leaf.tabMan.activeFile?.path;
      }
    }
    return undefined;
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
   * True when nothing open in the given window has unsaved changes — or, with
   * no window named, when nothing anywhere does. This is the gate in front of
   * the close prompt, so a wrong 'clean' is a prompt the user never sees.
   *
   * It used to take a second argument choosing between a window id and a leaf
   * id, defaulting to leaf. Both callers pass a window id and neither passed
   * the selector, so both fell into the leaf branch, where no leaf ever
   * carries a window's id — every window with unsaved changes answered clean,
   * and closing one asked nothing and discarded nothing. Nothing scopes this
   * question to a leaf, so there is no leaf mode to get wrong.
   */
  public isClean(windowId?: string): boolean {
    if (windowId !== undefined && !(windowId in this._windows)) {
      // A window this manager has already dropped holds no documents, so it
      // holds no unsaved changes. The close flow reaches this on purpose:
      // askUserToCloseWindow drops the window itself, and the close it then
      // permits runs this gate a second time.
      return true;
    }
    const scope =
      windowId === undefined ? this.documents : this._windowExclusiveDocuments(windowId);
    return scope.every((doc) => !this.isModified(doc.filePath));
  }

  /**
   * The loaded documents open in a window's panes: the exact set that window's
   * close prompt speaks for. Callers act on this set — save it, throw it away —
   * so an id no window answers to throws by name rather than quietly resolving
   * to 'no documents', which would swallow the user's answer whole.
   */
  private _windowDocuments(windowId: string): Document[] {
    const tree = this._windows[windowId];
    if (tree === undefined) {
      throw new Error(
        `[DocumentManager] Cannot enumerate the documents of unknown window ${windowId}`,
      );
    }
    const openPaths = new Set(
      tree.getAllLeafs().flatMap((leaf) => leaf.tabMan.openFiles.map((file) => file.path)),
    );
    return this.documents.filter((doc) => openPaths.has(doc.filePath));
  }

  /**
   * Documents whose final live owner is the named window. A window-close
   * decision may save, discard, or unload only these buffers; any document
   * still present in another window remains owned there.
   */
  private _windowExclusiveDocuments(windowId: string): Document[] {
    const otherWindowPaths = new Set(
      Object.entries(this._windows)
        .filter(([otherWindowId]) => otherWindowId !== windowId)
        .flatMap(([, tree]) =>
          tree.getAllLeafs().flatMap((leaf) => leaf.tabMan.openFiles.map((file) => file.path)),
        ),
    );
    return this._windowDocuments(windowId).filter(
      (document) => !otherWindowPaths.has(document.filePath),
    );
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
   * The live working text of an open document, normalized. Every review read
   * and every transition takes this explicitly: the document authority owns
   * the text, and a review that outlives its document is a lifecycle bug the
   * caller must not paper over with an empty string.
   */
  private _workingTextOf(documentId: string): string | undefined {
    const doc = this.documents.find((d) => d.documentId === documentId);
    return doc === undefined ? undefined : normalizeText(doc.document.toString());
  }

  /**
   * Announce one committed review fact. The payload's `generation` is the
   * wire's `reviewGeneration`; anything the emitter left implicit is filled
   * from the committed review, so a caller never has to restate the state it
   * just committed.
   */
  public emitAgentEvent(event: AgentEventType, payload: AgentEventPayload): void {
    const { generation, ...mapped } = payload;
    if (generation !== undefined) {
      mapped.reviewGeneration = generation;
    }
    const documentId = typeof mapped.documentId === "string" ? mapped.documentId : undefined;
    if (documentId !== undefined) {
      const review = this._reviewApplication.getReview(documentId);
      const workingText = this._workingTextOf(documentId);
      if (review !== undefined) {
        if (!("reviewGeneration" in mapped)) {
          mapped.reviewGeneration = review.generation;
        }
        if (!("unresolvedChunks" in mapped) && workingText !== undefined) {
          mapped.unresolvedChunks = this._reviewApplication.getStatus(documentId)?.unresolvedChunks;
        }
      }
    }
    const agentEvent: AgentEvent = {
      ...mapped,
      event,
      timestamp: new Date().toISOString(),
    };
    this.agentEvents.emit(event, agentEvent);
    this.agentEvents.emit("*", agentEvent);
  }

  // ==========================================================================
  // CollaborationDocumentAuthority — what the collaboration application
  // service may ask of the document authority, and nothing more.
  // ==========================================================================

  public resolveDocumentPath(documentId: string): string | undefined {
    return this.getDocumentPath(documentId);
  }

  /** The document's bytes as they currently are on disk. */
  public async readDiskText(documentPath: string): Promise<string> {
    return readFile(documentPath, "utf8");
  }

  /**
   * The hash of the bytes this document was last saved from, or undefined
   * when it is not open. This is what a first proposal fences against: the
   * user's own unsaved edits are exactly what the baseline hash binds, so
   * only somebody else's write may refuse the submission.
   */
  public readSavedDiskSha256(documentId: string): string | undefined {
    const filePath = this.getDocumentPath(documentId);
    const doc =
      filePath === undefined
        ? undefined
        : this.documents.find((candidate) => candidate.filePath === filePath);
    return doc === undefined ? undefined : sha256Text(normalizeText(doc.lastSavedContent));
  }

  /**
   * Compute — but do not apply — the replacement of the live document text.
   *
   * Only the changed span is spliced. A whole-document replacement maps every
   * pane's selection through a change covering the full text, which collapses
   * cursors to the splice boundary; trimming the common prefix and suffix
   * leaves positions outside the edit untouched.
   *
   * Serialization happens here because serializeChangeSet throws on a shape
   * it does not recognize. A throw between the version bump and the push
   * would consume a version number with no update for peers to pull — a
   * dirty buffer that can never be saved. Committing after this cannot throw.
   */
  public prepareWorkingTextReplacement(
    documentId: string,
    nextText: string,
  ): PreparedDocumentMutation {
    const documentPath = this.getDocumentPath(documentId);
    if (documentPath === undefined) {
      throw new Error(`Cannot replace text for missing document ${documentId}`);
    }
    const doc = this.documents.find((d) => d.filePath === documentPath);
    if (doc === undefined) {
      throw new Error(`Cannot replace text for closed document ${documentId}`);
    }
    if (doc.document.toString() === nextText) {
      return { documentId, documentPath, change: undefined };
    }
    const currentText = doc.document.toString();
    let prefix = 0;
    const shorter = Math.min(currentText.length, nextText.length);
    while (prefix < shorter && currentText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < shorter - prefix &&
      currentText.charCodeAt(currentText.length - 1 - suffix) ===
        nextText.charCodeAt(nextText.length - 1 - suffix)
    ) {
      suffix++;
    }
    const changes = ChangeSet.of(
      [
        {
          from: prefix,
          to: currentText.length - suffix,
          insert: nextText.slice(prefix, nextText.length - suffix),
        },
      ],
      doc.document.length,
    );
    return {
      documentId,
      documentPath,
      change: {
        changes,
        update: {
          changes: serializeChangeSet(changes),
          clientID: "review-diff-store",
        },
        nextText: Text.of(nextText.split("\n")),
        nextVersion: doc.currentVersion + 1,
      },
    };
  }

  /** Apply a prepared replacement. Synchronous, and cannot throw. */
  public commitWorkingTextReplacement(prepared: PreparedDocumentMutation): void {
    if (prepared.change === undefined) {
      return;
    }
    const doc = this.documents.find((d) => d.filePath === prepared.documentPath);
    if (doc === undefined) {
      return;
    }
    doc.document = prepared.change.nextText;
    doc.currentVersion = prepared.change.nextVersion;
    doc.updates.push(prepared.change.update);
    while (doc.updates.length > MAX_VERSION_HISTORY) {
      doc.updates.shift();
      doc.minimumVersion += 1;
    }
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      filePath: prepared.documentPath,
      status: "modification",
    });

    // A review decision changed the authority text: feed the references
    // provider's live overlay (issue #53).
    if (doc.type === DocumentType.Markdown) {
      this._app.references.reportAuthorityBuffer(prepared.documentPath);
    }
  }

  /**
   * Broadcast a document's whole collaboration state — annotations, and
   * review if one is active — as one DocumentCollaborationSession. Every
   * annotation and review mutation ends here: one event, one shape, so a
   * pane and the annotations panel can never observe one half updated and
   * the other stale.
   */
  public broadcastCollaborationState(documentId: string): void {
    const filePath = this.getDocumentPath(documentId);
    if (filePath === undefined) {
      return;
    }
    const session = this._collaborationSessionFor(documentId, filePath);
    if (session === undefined) {
      return;
    }
    this.broadcastEvent(DP_EVENTS.DOCUMENT_COLLABORATION, {
      filePath,
      collaborationSession: session,
    });
  }

  /**
   * A review closed, completed, or was invalidated. The service has already
   * removed it before calling this, so the rebuilt session naturally reports
   * `review: undefined` — the same one broadcast path as every other
   * collaboration change, with no second wire shape for "cleared" to drift
   * from the first. `reviewId` is kept on the signature because the
   * CollaborationDocumentAuthority seam (owned by M3) declares it; nothing
   * here still needs the value once the rebuilt session already says so.
   */
  public broadcastReviewCleared(documentId: string, _reviewId: string): void {
    this.broadcastCollaborationState(documentId);
  }

  // ==========================================================================
  // Review mutations — one delegation each. The HTTP API and renderer IPC
  // call these same methods; the service owns the transaction.
  // ==========================================================================

  public decideReviewChunk(
    reviewId: string,
    chunkId: string,
    decision: ChunkDecision,
    precondition: ReviewMutationPrecondition,
  ): Promise<ChunkDecisionResponse | ReviewFailure> {
    return this._reviewApplication.decideChunk(reviewId, chunkId, decision, precondition);
  }

  public commentReviewChunk(
    reviewId: string,
    chunkId: string,
    text: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<ChunkCommentResponse | ReviewFailure> {
    return this._reviewApplication.commentChunk(reviewId, chunkId, text, precondition);
  }

  public acceptAllReviewChunks(
    reviewId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<AcceptAllChunksResponse | ReviewFailure> {
    return this._reviewApplication.acceptAllChunks(reviewId, precondition);
  }

  public clearReview(
    reviewId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<ClearReviewResponse | ReviewFailure> {
    return this._reviewApplication.clearReview(reviewId, precondition);
  }

  public addReviewComment(
    reviewId: string,
    text: string,
    expectedReviewGeneration: number,
  ): Promise<AddReviewCommentResponse | ReviewFailure> {
    return this._reviewApplication.addReviewComment(reviewId, text, expectedReviewGeneration);
  }

  /** Map a frozen review onto the current text; see prepareReapply. */
  public async reapplyReview(
    reviewId: string,
    expectedReviewGeneration: number,
  ): Promise<ReapplyReviewResponse | ReviewFailure> {
    const input = await this._reviewRecoveryInput(reviewId, expectedReviewGeneration);
    return "ok" in input ? input : await this._reviewApplication.reapplyReview(input);
  }

  /** Remove a frozen review; the file keeps its text. */
  public async discardInvalidatedReview(
    reviewId: string,
    expectedReviewGeneration: number,
  ): Promise<DiscardReviewResponse | ReviewFailure> {
    const input = await this._reviewRecoveryInput(reviewId, expectedReviewGeneration);
    return "ok" in input ? input : await this._reviewApplication.discardInvalidatedReview(input);
  }

  /** The document a review belongs to, open or closed. */
  private async _reviewRecoveryInput(
    reviewId: string,
    expectedReviewGeneration: number,
  ): Promise<ReviewRecoveryInput | ReviewFailure> {
    const query = await this._reviewApplication.findReviewQuery(reviewId);
    if (query === undefined) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: `Review ${reviewId} not found.`,
      };
    }
    if (query.attached) {
      return {
        documentId: query.documentId,
        documentPath: query.documentPath,
        reviewId,
        expectedReviewGeneration,
      };
    }
    const documentPath = query.sidecar.documentPath;
    return {
      documentId: this.ensureDocumentId(documentPath),
      documentPath,
      reviewId,
      expectedReviewGeneration,
    };
  }

  /**
   * Returns the reason a review blocks saving `filePath`, or undefined when the
   * save may proceed. Presentation is the renderer's job — see SaveRefusal.
   */
  private async checkReviewDiffSaveGate(filePath: string): Promise<SaveRefusal | undefined> {
    const docId = this.getDocumentId(filePath);
    if (docId === undefined) {
      return undefined;
    }
    const review = this._reviewApplication.getReview(docId);
    if (review === undefined) {
      return undefined;
    }

    // Pending chunks do not block a save: saving persists the document as-is
    // and the review's status alongside it, so a pending review can be closed
    // and revisited later. The only refusal left is external drift.
    const disk = await this._app.fsal.loadAnySupportedFile(filePath).then(
      (contents): { contents: string } => ({ contents }),
      (err: unknown): { unreadable: string } => {
        this._app.log.error(
          `[DocumentManager] Save gate closed for ${filePath}: the file could not be read.`,
          err,
        );
        return { unreadable: err instanceof Error ? err.message : String(err) };
      },
    );
    if ("unreadable" in disk) {
      // The gate cannot tell whether the file changed after the review
      // opened, so the save does not replace the file.
      return {
        reason: "disk-unreadable",
        message: trans(
          "The file could not be read, so the save could not compare it with its review, and nothing was written: %s",
          disk.unreadable,
        ),
      };
    }
    if (sha256Text(normalizeText(disk.contents)) !== review.diskFenceSha256) {
      this._app.log.warning(
        `[DocumentManager] Save gate closed for ${filePath}: the document changed on disk ` +
          "after the review opened; the external edit was preserved.",
      );
      return {
        reason: "disk-changed",
        message: trans(
          "The document changed on disk after this review opened, so it was not saved. Load the disk version, or reapply or discard the review in the Annotations view and save again.",
        ),
      };
    }

    return undefined;
  }

  /**
   * Save a document. Serialized against every other writer of this document:
   * the save gate, the disk write, and the review's own resolution all have
   * to see one consistent state, and an editor update or an agent decision
   * arriving mid-save is exactly what would break that.
   */
  public async saveFile(filePath: string): Promise<SaveFileResult> {
    return this._reviewApplication.withDocumentLock(
      this.ensureDocumentId(filePath),
      async () => await this._saveFileLocked(filePath),
    );
  }

  /**
   * Writes the text that the application holds of a document to a file that
   * the author chooses. The document keeps its path, its unsaved text and
   * its review. This is the way out for text that a refused save cannot put
   * into the file of the document.
   *
   * @return The path of the copy, or undefined when the author chose no file.
   * @throws {Error} If the document is not loaded, if the chosen file is the
   *                 file of a loaded document, or if the write fails.
   */
  public async saveCopy(filePath: string): Promise<string | undefined> {
    const name = path.basename(filePath);
    const notLoaded = (): Error =>
      new Error(trans("The application holds no text of %s, so there is nothing to copy.", name));
    if (!this.documents.some((doc) => doc.filePath === filePath)) {
      throw notLoaded();
    }

    const extension = path.extname(filePath);
    const target = await this._app.windows.saveFile(
      path.join(
        path.dirname(filePath),
        trans("%s copy", path.basename(filePath, extension)) + extension,
      ),
    );
    if (target === undefined) {
      return undefined;
    }
    // A write to the file of a loaded document is a save of that document,
    // and a save goes through its own gates.
    if (this.documents.some((doc) => doc.filePath === target)) {
      throw new Error(
        trans(
          "%s is open in the application. Choose another file for the copy.",
          path.basename(target),
        ),
      );
    }

    // The text is read under the document lock, so the copy is one state of
    // the document. The dialog is not: the author can type while it is open.
    return await this._reviewApplication.withDocumentLock(
      this.ensureDocumentId(filePath),
      async () => {
        const doc = this.documents.find((doc) => doc.filePath === filePath);
        if (doc === undefined) {
          throw notLoaded();
        }
        const content = [...doc.document.iterLines()].join("\n");
        await this._app.fsal.writeTextFile(target, this._fileTextOf(doc, content));
        return target;
      },
    );
  }

  /**
   * The text of a file of `doc` that holds `content`. The application keeps
   * every text with LF line ends; a Markdown file has the byte order mark
   * and the line ends that it had when it was read.
   */
  private _fileTextOf(doc: Document, content: string): string {
    return doc.descriptor.type === "file"
      ? doc.descriptor.bom + content.split("\n").join(doc.descriptor.linefeed)
      : content;
  }

  private async _saveFileLocked(filePath: string): Promise<SaveFileResult> {
    const doc = this.documents.find((doc) => doc.filePath === filePath);

    if (doc === undefined) {
      this._app.log.error(
        `[Document Provider] Could not save file ${filePath}: Not found in loaded documents!`,
      );
      return {
        ok: false,
        refusal: {
          reason: "not-loaded",
          message: trans(
            "The application holds no text of %s, so nothing was written. Open the document again.",
            path.basename(filePath),
          ),
        },
      };
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

    // The version and the text of this save are read here, before the write,
    // and recorded as saved only after the write. A change that the author
    // makes while the write runs has a later version, so the document stays
    // modified. A write that fails records nothing: the document keeps text
    // that is not on disk, and it must read as modified, or a close and a
    // quit drop that text without a question.

    // NOTE: Zettlr internally always uses regular LF linefeeds. The FSAL load
    // and FSAL save methods will take care to actually use the proper linefeeds
    // and BOMs. So here we will always use newlines. This should fix and in the
    // future prevent bugs like #4959
    const docLines = [...doc.document.iterLines()];
    const content = docLines.join("\n");
    const savedVersion = doc.currentVersion;

    // 8.6: a surviving review's sidecar records the save it is about to
    // survive BEFORE the document write, naming both hashes. A process that
    // exits between the two writes is then recoverable: reattachment reads
    // the file and can tell which of them landed. The fence itself does not
    // move until the document write returns.
    const documentId = this.getDocumentId(filePath);
    const savedSha256 = sha256Text(content);
    let reviewSave: ReviewSavePreparation | undefined;
    try {
      reviewSave =
        documentId === undefined
          ? undefined
          : await this._reviewApplication.prepareSave(documentId, savedSha256);
    } catch (err) {
      // Nothing is written to disk: an unrecorded save is what makes the
      // crash window unrecoverable, so the save does not start.
      return { ok: false, refusal: this._persistenceRefusal(filePath, err) };
    }

    this._ignoreChanges.push(filePath);

    let written = false;
    try {
      await this._app.fsal.writeTextFile(doc.descriptor.path, this._fileTextOf(doc, content));
      // The file has the text. The watcher compares the file with
      // lastSavedContent, so it is recorded before the next await.
      written = true;
      doc.lastSavedVersion = savedVersion;
      doc.lastSavedContent = content;
      const refreshed = (await this._app.fsal.getDescriptorFor(doc.descriptor.path, false)) as
        | MDFileDescriptor
        | CodeFileDescriptor;
      // A file that can be written and not read has a descriptor of a file
      // without text. The document keeps the descriptor of its last read.
      if (refreshed.readError !== undefined) {
        return {
          ok: false,
          refusal: this._savedNotRefreshed(doc, refreshed.readError.message, refreshed.readError),
        };
      }
      doc.descriptor = refreshed;
      if (refreshed.type === "file") {
        this.startDatabaseSynchronization(); // The file may have gotten a library
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (written) {
        return { ok: false, refusal: this._savedNotRefreshed(doc, reason, err) };
      }
      // The write failed, so the next change of the file is not this save.
      this._ignoreChanges.splice(this._ignoreChanges.lastIndexOf(filePath), 1);
      this._app.log.error(`[DocumentManager] Could not write ${filePath}: ${reason}`, err);
      return {
        ok: false,
        refusal: {
          reason: "write-failed",
          message: trans("Could not save file %s: %s", doc.descriptor.name, reason),
        },
      };
    }

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

    this._app.log.info(`[DocumentManager] File ${filePath} saved.`);
    this._app.recentDocs.markEdited(filePath);
    if (reviewSave !== undefined) {
      try {
        await this._reviewApplication.completeSave(reviewSave, savedSha256);
      } catch (err) {
        // The document IS written; only the fence update was lost. The
        // sidecar still carries pendingSave, so reattachment settles it —
        // but this save did not complete, and must not report that it did.
        return { ok: false, refusal: this._persistenceRefusal(filePath, err) };
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
      filePath: this.getActiveFile(leafId),
    });
  }

  // ==========================================================================
  // Agent API: documentId, focused-view, snapshot tokens, proposal submission
  //
  // ==========================================================================

  /**
   * Get or assign the opaque documentId for a loaded document path.
   * The documentId is stable for the lifetime of a loaded document.
   */
  public getDocumentId(filePath: string): string | undefined {
    return this._documentIdByPath.get(filePath);
  }

  /** The typed refusal every owner-facing annotation channel gives an unresolved path. */
  private _annotationDocumentNotFound(filePath: string): AnnotationFailure {
    return {
      ok: false,
      code: "DOCUMENT_NOT_FOUND",
      message: `No open document at ${filePath}.`,
    };
  }

  /**
   * The documentId a bulk owner mutation works on: the live document, or —
   * for a document no pane shows — a collaboration sidecar for that path,
   * which is the only annotation state a closed document has. Assigning an
   * id is cheap and stable, but it is also why this must not become the
   * general channel for an arbitrary path: it exists because the panel's
   * projection just read that sidecar through ensureDocumentId.
   */
  private async _documentIdForBulkOwnerMutation(filePath: string): Promise<string | undefined> {
    const live = this.getDocumentId(filePath);
    if (live !== undefined) {
      return live;
    }
    const sidecar = await this._reviewApplication.readSidecar(filePath);
    if (sidecar === undefined) {
      return undefined;
    }
    return this.ensureDocumentId(filePath);
  }

  /** Resolve the open annotations of one document, owner-actor hardcoded. */
  private async _resolveActedAnnotations(
    documentId: string,
    expectedAnnotationGeneration: number,
    scope: "acted" | "open",
  ): Promise<{ resolved: TextAnnotation[] } | AnnotationFailure> {
    const result = await this._reviewApplication.resolveActedAnnotations({
      documentId,
      actor: "owner",
      expectedAnnotationGeneration,
      scope,
    });
    if ("ok" in result) {
      return result;
    }
    return { resolved: result };
  }

  /** Delete every resolved annotation of one document, owner-actor hardcoded. */
  private async _deleteResolvedAnnotations(
    documentId: string,
    expectedAnnotationGeneration: number,
  ): Promise<{ deleted: TextAnnotation[] } | AnnotationFailure> {
    const result = await this._reviewApplication.deleteResolvedAnnotations({
      documentId,
      actor: "owner",
      expectedAnnotationGeneration,
    });
    if ("ok" in result) {
      return result;
    }
    return { deleted: result };
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
   *
   * `startedBy` is the window whose close or whose "save all" asked for the
   * save; a quit has none.
   */
  private _announceSaveRefusal(filePath: string, result: SaveFileResult, startedBy?: string): void {
    if (result.ok) {
      return;
    }
    this._app.log.warning(
      `[DocumentManager] Close aborted: ${filePath} could not be saved ` +
        `(${result.refusal.reason}): ${result.refusal.message}`,
    );
    const payload: SaveRefusedBroadcast = {
      filePath,
      refusal: result.refusal,
    };
    this._tellAbout(filePath, startedBy, SAVE_REFUSED_CHANNEL, payload);
  }

  /**
   * DETACH, not destroy: write the review through to its sidecar, then drop
   * the in-memory state. Closing a reviewed file is free — reopening the
   * file reattaches the review. Must run while the document is still in
   * `documents`: the export needs its working text. An invalidated review
   * is written through frozen, like any other.
   *
   * A failed write ABORTS the close. It throws, the review stays in memory,
   * the document stays open, and the sidecar keeps its previous valid state.
   * Catching the error and closing anyway is what turned an unwritable
   * sidecar into a silently destroyed review.
   */
  private async _detachCollaboration(documentId: string): Promise<void> {
    await this._reviewApplication.withDocumentLock(documentId, async () => {
      await this._reviewApplication.detachCollaboration(documentId);
    });
  }

  /**
   * The detach of a close. Resolves false when the state could not be
   * written: the close does not happen, the document stays loaded with its
   * state, and one window names the cause with one action (_tellAbout;
   * `startedBy` is the window of the close). That action is
   * closeWithoutReview, which runs `repeatClose` after it dropped the
   * state. No close is refused without it (#178).
   *
   * A reload from disk and a quit detach the same way: `action` says
   * which of the three the refusal stopped. A quit detaches only a document
   * that no pane shows, so its action leaves the review as its sidecar
   * last held it; the message says so.
   */
  private async _detachForClose(
    documentId: string,
    filePath: string,
    repeatClose: () => Promise<void>,
    action: RefusedAction = "close",
    startedBy?: string,
  ): Promise<boolean> {
    return await this._detachCollaboration(documentId).then(
      () => {
        this._refusedCloses.delete(documentId);
        return true;
      },
      (err: unknown) => {
        this._refusedCloses.set(documentId, { repeat: repeatClose, textDiscarded: false });
        this._announceRefusedClose(
          filePath,
          documentId,
          "review-not-persisted",
          REVIEW_NOT_SAVED[action],
          err,
          action,
          startedBy,
        );
        return false;
      },
    );
  }

  /**
   * The answer "discard" at a close prompt, for one document. Resolves
   * false when the discard failed: the collaboration state could not be
   * written, or the file could not be read. The close does not happen, the
   * document keeps its text and its state, and one window names the
   * cause with the action of _detachForClose. That action closes the
   * document with the text that the author discarded (#178). `action`
   * says whether the prompt was that of a close or that of a quit.
   */
  private async _discardForClose(
    document: Document,
    repeatClose: () => Promise<void>,
    action: "close" | "quit",
    startedBy?: string,
  ): Promise<boolean> {
    return await this._discardChanges(document).then(
      () => true,
      (err: unknown) => {
        this._refusedCloses.set(document.documentId, { repeat: repeatClose, textDiscarded: true });
        this._announceRefusedClose(
          document.filePath,
          document.documentId,
          "discard-failed",
          CHANGES_NOT_DISCARDED[action],
          err,
          action,
          startedBy,
        );
        return false;
      },
    );
  }

  /** Removes a document from the loaded set, with its reference overlay. */
  private _unload(document: Document): void {
    const index = this.documents.indexOf(document);
    if (index === -1) {
      throw new Error(`Document ${document.filePath} is not loaded`);
    }
    this.documents.splice(index, 1);
    this._refusedCloses.delete(document.documentId);
    this._app.references.dropAuthorityBuffer(document.filePath);
  }

  /**
   * The author's answer to a refused close: close without the state that
   * could not be written. The state in memory goes; the sidecar stays as
   * it was last written, so the next load of the document attaches that.
   * Resolves false when no close of this document is refused now.
   *
   * A document that no pane shows is unloaded: its buffer is the working
   * text of the review that goes. A document in a pane keeps its buffer,
   * and the repeated close asks about unsaved text as each close does.
   *
   * The buffer of a document whose review has an undecided proposal is the
   * working text of that review, in a pane too. The sidecar has that text,
   * because each change of such a document writes the sidecar first. The
   * buffer takes the text of the file, so the repeated close has no
   * proposal to offer for a save (#146).
   *
   * A document whose unsaved text the author discarded leaves every pane
   * and is unloaded: its buffer is the text that the author threw away,
   * and the discard that puts the text of the file back is what failed.
   */
  public async closeWithoutReview(documentId: string): Promise<boolean> {
    const refused = this._refusedCloses.get(documentId);
    if (refused === undefined) {
      return false;
    }
    this._refusedCloses.delete(documentId);
    const document = this.documents.find((doc) => doc.documentId === documentId);
    const heldUndecidedProposal = document !== undefined && this._holdsUndecidedProposal(document);
    await this._reviewApplication.withDocumentLock(documentId, async () => {
      this._reviewApplication.dropCollaboration(documentId);
    });
    if (document !== undefined) {
      if (heldUndecidedProposal) {
        this._applyWorkingTextToDocument(document.filePath, document.lastSavedContent);
        document.lastSavedVersion = document.currentVersion;
      }
      if (refused.textDiscarded) {
        await this._closeTabsEverywhere(document.filePath);
      }
      if (this._pathsShownInPanes().has(document.filePath)) {
        this.broadcastCollaborationState(documentId);
      } else {
        this._unload(document);
        this.syncWatchedFilePaths();
      }
    }
    await refused.repeat();
    return true;
  }

  /**
   * The answer of a save that wrote the file and could not read it again. The
   * text is on disk, so the document is not modified.
   */
  private _savedNotRefreshed(doc: Document, reason: string, cause: unknown): SaveRefusal {
    this._app.log.error(
      `[DocumentManager] ${doc.descriptor.path} was written, and its new state could not be read: ${reason}`,
      cause,
    );
    return {
      reason: "saved-not-refreshed",
      message: trans(
        "%s was saved, but the application could not read the file again: %s",
        doc.descriptor.name,
        reason,
      ),
    };
  }

  /** The refusal a save owes when the review could not be persisted. */
  private _persistenceRefusal(filePath: string, err: unknown): SaveRefusal {
    const message =
      "The review could not be saved, so the document was not saved: " +
      (err instanceof Error ? err.message : String(err));
    this._app.log.error(`[DocumentManager] Save refused for ${filePath}: ${message}`, err);
    return { reason: "review-not-persisted", message };
  }

  /**
   * A close, a reload or a quit that the provider refused. The window shows
   * this as it shows a refused save, with the document for which the author
   * can repeat the action without the state that stopped it
   * (closeWithoutReview).
   */
  private _announceRefusedClose(
    filePath: string,
    documentId: string,
    reason: SaveRefusalReason,
    what: RefusalMessage,
    err: unknown,
    action: RefusedAction,
    startedBy: string | undefined,
  ): void {
    const message = what(err instanceof Error ? err.message : String(err));
    this._app.log.error(`[DocumentManager] Close aborted for ${filePath}: ${message}`, err);
    const payload: SaveRefusedBroadcast = {
      filePath,
      refusal: { reason, message },
      refused: { documentId, action },
    };
    this._tellAbout(filePath, startedBy, SAVE_REFUSED_CHANNEL, payload);
  }

  /**
   * The user's "Don't save" answer, applied to one document. DESTROY, where
   * _detachCollaboration preserves: the bytes thrown away die everywhere this
   * provider captured them — the buffer, the in-memory review, and the
   * review's sidecar file.
   *
   * Every close prompt used to hand-roll this as
   * `lastSavedVersion = currentVersion` plus _detachCollaboration, and both halves
   * reversed the decision. Silencing the dirty flag left the discarded text
   * in the buffer, where a pane in another window still showed it and the
   * next save would write it. Detaching wrote that same live text through to
   * the sidecar — and since a discard writes nothing to disk, the sidecar's
   * disk fence still matched the untouched file, so the next open verified
   * the fence, restored the working text, and put the discarded edit back
   * with no signal that anything had been resurrected.
   *
   * So: the buffer returns to its disk bytes through the same splice path a
   * review decision uses (every open pane follows). An already-saved review
   * is the one exception: when its disk fence still matches the file, the
   * later ordinary edit is discarded but the saved review remains in its
   * sidecar for the close/detach path. Any other review is closed and its
   * sidecar deleted. Only then is the document clean, because only then is
   * the claim true.
   *
   * The sidecar deletion is deliberately NOT wrapped in the error handling
   * _detachCollaboration uses: a discard whose file removal failed leaves those
   * bytes reattachable, and swallowing that would reinstate the defect. It
   * throws, and the close it was called from is refused (_discardForClose).
   */
  private async _discardChanges(doc: Document): Promise<void> {
    await this._reviewApplication.withDocumentLock(doc.documentId, async () => {
      await this._discardChangesLocked(doc);
    });
  }

  private async _discardChangesLocked(doc: Document): Promise<void> {
    if (doc.currentVersion === doc.lastSavedVersion) {
      // Nothing was thrown away here, so nothing may be destroyed here: a
      // saved document's review is not the user's to lose at another
      // document's prompt.
      return;
    }
    const diskContents = await this._app.fsal.loadAnySupportedFile(doc.filePath);
    await this._reviewApplication.discardCollaboration(doc.documentId, doc.filePath, diskContents);
    this._applyWorkingTextToDocument(doc.filePath, diskContents);
    doc.lastSavedContent = diskContents;
    doc.lastSavedVersion = doc.currentVersion;
  }

  /**
   * A sidecar failure is never swallowed: it lands in the log for the
   * operator and on the store's event bus for the API (SSE), because the
   * mutation that triggered it already answered its caller.
   */
  private _surfaceReviewSidecarError(documentId: string, action: string, err: unknown): void {
    const message = `Could not ${action} review state for document ${documentId}.`;
    this._app.log.error(
      `[DocumentManager] Review sidecar ${action} failed for document ${documentId}`,
      err,
    );
    this.emitAgentEvent("review.sidecar-error", { documentId, message });
  }

  /**
   * Reattachment — the second half of detach, run when a document loads.
   * Find the sidecar by canonical path, settle any interrupted save, verify
   * the disk fence, then restore the buffer to the working text and the
   * review to its reference. A fence mismatch is external drift observed
   * across a gap in time instead of within a process: the review is frozen
   * and announced invalidated, and the file opens with the disk content.
   * The document's annotations survive that; their anchors become
   * `orphaned` and wait for the owner to reattach them.
   */
  private async _reattachCollaborationSidecar(doc: Document): Promise<void> {
    try {
      const restored = await this._reviewApplication.reattachCollaboration(
        doc.documentId,
        doc.filePath,
        doc.lastSavedContent,
      );
      if (restored === undefined) {
        return;
      }
      // Only a restored review gives the working text of the sidecar a
      // claim on the buffer.
      if (restored.workingText !== undefined) {
        this._applyWorkingTextToDocument(doc.filePath, restored.workingText);
      }
      // The window keeps the session that it gets for the document, and an
      // editor shows a review only while its text is the working text of
      // that session. The session goes out after the buffer has its text.
      this.broadcastCollaborationState(doc.documentId);
    } catch (err) {
      // The document itself is fine — open it; the sidecar stays on disk as
      // it is and keeps failing loudly until it is dealt with.
      if (err instanceof CollaborationSidecarUnreadableError) {
        this._surfaceReviewSidecarError(doc.documentId, "read", err);
        // The window says so and offers to move the file aside.
        const payload: CollaborationFileUnreadableBroadcast = {
          filePath: doc.filePath,
          file: this._reviewApplication.sidecarFileOf(doc.filePath),
          cause: err.message,
        };
        this._tellAbout(doc.filePath, undefined, COLLABORATION_FILE_UNREADABLE_CHANNEL, payload);
        return;
      }
      if (!isErrnoException(err)) {
        throw err;
      }
      // The file was read; the attach to the text of the file could not
      // write it. Nothing of it is in memory, and the next load attaches it
      // again. A move aside is a write too, so the window offers none.
      this._surfaceReviewSidecarError(doc.documentId, "write", err);
      const payload: CollaborationFileUnwritableBroadcast = {
        filePath: doc.filePath,
        cause: err.message,
      };
      this._tellAbout(doc.filePath, undefined, COLLABORATION_FILE_UNWRITABLE_CHANNEL, payload);
    }
  }

  /**
   * Get the file path for a documentId.
   */
  public getDocumentPath(documentId: string): string | undefined {
    return this._documentPathById.get(documentId);
  }

  public isDocumentOpen(documentPath: string): boolean {
    return this.documents.some(
      (document) => path.resolve(document.filePath) === path.resolve(documentPath),
    );
  }

  public readSupportedFile(filePath: string): Promise<string> {
    return this._app.fsal.loadAnySupportedFile(filePath);
  }

  /**
   * The text of a document: the buffer of a loaded document, which can hold
   * text that is not on disk and outlives its file (§14), else the file.
   */
  public readDocumentText(filePath: string): Promise<string> {
    const doc = this.documents.find((d) => path.resolve(d.filePath) === path.resolve(filePath));
    if (doc !== undefined) {
      return Promise.resolve(doc.document.toString());
    }
    return this.readSupportedFile(filePath);
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
    this._documentPathById.set(id, filePath);
    return id;
  }

  /**
   * The id of the document at `oldPath` names `newPath` from here on. An
   * id that named `newPath` belonged to the file that the move replaced:
   * it names no path, and a refused close of that document has no object.
   */
  private _moveDocumentId(documentId: string, oldPath: string, newPath: string): void {
    const replacedId = this._documentIdByPath.get(newPath);
    if (replacedId !== undefined) {
      this._documentPathById.delete(replacedId);
      this._refusedCloses.delete(replacedId);
    }
    this._documentIdByPath.delete(oldPath);
    this._documentIdByPath.set(newPath, documentId);
    this._documentPathById.set(documentId, newPath);
  }

  /**
   * Resolve the currently focused view.
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
    if (activePath === undefined) {
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
   * Read the live buffer for a document.
   * Returns the current working text and its content hash — the hash a
   * proposal sends back as its baseline.
   */
  public readLiveBuffer(
    documentId: string,
    startLine?: number,
    endLine?: number,
  ):
    | {
        content: string;
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
      // CLI line ranges are one-based and inclusive
      const start = Math.max(0, startLine - 1);
      const end = Math.min(totalLines, endLine);
      content = lines.slice(start, end).join("\n");
      truncated = end < totalLines;
    }
    return {
      content,
      sha256: sha256Text(fullContent),
      lineCount: totalLines,
      truncated,
    };
  }

  /**
   * Submit an ordered claim sequence against a baseline content hash: applied
   * sequentially and atomically (all-or-nothing), one packet per claim.
   */
  public async submitProposal(
    documentId: string,
    baselineSha256: string,
    claims: ProposalClaim[],
    clientRequestId: string,
    expectedReviewGeneration: number,
  ): Promise<SubmittedProposal | ProposalRefusal> {
    return this._reviewApplication.submitProposal({
      documentId,
      baselineSha256,
      claims,
      clientRequestId,
      expectedReviewGeneration,
    });
  }

  public async retractProposal(
    packetId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<
    | RetractProposalResponse
    | {
        ok: false;
        code: AgentErrorCode;
        message: string;
        reviewId: string;
        canClearUnresolved: boolean;
        actual?: { sha256: string };
        reviewGeneration?: number;
      }
  > {
    const result = await this._reviewApplication.retractProposal(packetId, precondition);
    if (
      "ok" in result &&
      !result.ok &&
      result.code === "PACKET_NOT_RETRACTABLE" &&
      result.reviewId === ""
    ) {
      // GET /v1/reviews/{id}/packets hands out a detached review's packetIds,
      // so this route owes them an answer. The live store dropped them when
      // the file closed; the sidecar still carries them, and the refusal it
      // earns is the same one every reviewId route gives — the file is shut,
      // not the packet missing. Clearing is shut too, so say so.
      const detached = (await this._reviewApplication.listReviewQueries()).find(
        (query) =>
          !query.attached &&
          query.sidecar.review.packets.some((packet) => packet.packetId === packetId),
      );
      if (detached !== undefined && !detached.attached) {
        return {
          ok: false,
          code: "DOCUMENT_CLOSED",
          message: `The reviewed document ${detached.sidecar.documentPath} is closed. Open it before retracting this proposal.`,
          reviewId: detached.sidecar.review.reviewId,
          canClearUnresolved: false,
        };
      }
    }
    return result;
  }

  /**
   * The owner comments on a stretch of the document. Not reachable from the
   * agent HTTP API — only the renderer's owner-facing IPC calls this with
   * `actor: 'owner'`.
   */
  public async createAnnotation(
    documentId: string,
    actor: AnnotationActor,
    from: number,
    to: number,
    instruction: string,
    expectedAnnotationGeneration: number,
  ): Promise<TextAnnotation | AnnotationFailure> {
    return this._reviewApplication.createAnnotation({
      documentId,
      actor,
      from,
      to,
      instruction,
      expectedAnnotationGeneration,
    });
  }

  /**
   * One more turn of an annotation thread. The agent HTTP API exposes this
   * mutation and may mark its own reply as the acted disposition; owner
   * resolution, anchor and deletion lifecycle still route through the
   * owner-only transitions.
   */
  public async addAnnotationMessage(
    documentId: string,
    annotationId: string,
    actor: AnnotationActor,
    text: string,
    clientRequestId: string | undefined,
    expectedAnnotationGeneration: number,
    markActed?: boolean,
  ): Promise<AnnotationMessage | AnnotationFailure> {
    return this._reviewApplication.addAnnotationMessage({
      documentId,
      annotationId,
      actor,
      text,
      clientRequestId,
      markActed,
      expectedAnnotationGeneration,
    });
  }

  /** Owner-only lifecycle move (I3); not wired to any agent HTTP route. */
  public async resolveAnnotation(
    documentId: string,
    annotationId: string,
    actor: AnnotationActor,
    expectedAnnotationGeneration: number,
  ): Promise<TextAnnotation | AnnotationFailure> {
    return this._reviewApplication.resolveAnnotation({
      documentId,
      annotationId,
      actor,
      expectedAnnotationGeneration,
    });
  }

  /** Owner-only lifecycle move (I3); not wired to any agent HTTP route. */
  public async reopenAnnotation(
    documentId: string,
    annotationId: string,
    actor: AnnotationActor,
    expectedAnnotationGeneration: number,
  ): Promise<TextAnnotation | AnnotationFailure> {
    return this._reviewApplication.reopenAnnotation({
      documentId,
      annotationId,
      actor,
      expectedAnnotationGeneration,
    });
  }

  /** Owner-only lifecycle move (I3); not wired to any agent HTTP route. */
  public async reattachAnnotation(
    documentId: string,
    annotationId: string,
    actor: AnnotationActor,
    from: number,
    to: number,
    expectedAnnotationGeneration: number,
  ): Promise<TextAnnotation | AnnotationFailure> {
    return this._reviewApplication.reattachAnnotation({
      documentId,
      annotationId,
      actor,
      from,
      to,
      expectedAnnotationGeneration,
    });
  }

  /** Owner-only lifecycle move (I3); not wired to any agent HTTP route. */
  public async deleteAnnotation(
    documentId: string,
    annotationId: string,
    actor: AnnotationActor,
    expectedAnnotationGeneration: number,
  ): Promise<TextAnnotation | AnnotationFailure> {
    return this._reviewApplication.deleteAnnotation({
      documentId,
      annotationId,
      actor,
      expectedAnnotationGeneration,
    });
  }

  /**
   * Get the review store for direct agent API method dispatch.
   */
  public get reviewStore(): CollaborationApplicationService["reviewStore"] {
    return this._reviewApplication.reviewStore;
  }

  /** Read-only review projections for transport providers. */
  public get reviewQueries(): ReviewQueryPort {
    return this._reviewApplication;
  }

  /** Read-only annotation projections for transport providers. */
  public get annotationQueries(): Pick<
    CollaborationApplicationService,
    "getAnnotations" | "listCollaborationSidecars"
  > {
    return this._reviewApplication;
  }

  /**
   * The live working text of an open document, normalized — the text every
   * review read projection must be given. Undefined when the document is not
   * open, which is the caller's signal that only the sidecar can answer.
   */
  public readWorkingText(documentId: string): string | undefined {
    return this._workingTextOf(documentId);
  }

  /**
   * The status of a document's active review, against its live text. The one
   * place the working text is paired with the review for a status read, so
   * no caller can project a review against a text it does not have.
   */
  public reviewStatus(documentId: string): ReviewStatus | undefined {
    return this._reviewApplication.getStatus(documentId);
  }

  /**
   * Expose the loaded documents array for the agent API provider to enumerate
   * open documents.
   */
  public get loadedDocuments(): readonly Document[] {
    return this.documents;
  }

  /**
   * The references provider's read seam into the document authority
   * (issue #53): returns the CURRENT text of an open markdown buffer, or
   * undefined when the path is not an open markdown document. This is the
   * single source the provider derives live reference state from — both the
   * merged snapshot's live overlays and the rename protocol's open-buffer
   * partition and hash fences.
   *
   * @param   {string}  filePath  The document's path
   *
   * @return  {string|undefined}  The buffer text, if an open markdown doc
   */
  public readMarkdownBufferContent(filePath: string): string | undefined {
    const doc = this.documents.find((d) => d.filePath === filePath);
    if (doc === undefined || doc.type !== DocumentType.Markdown) {
      return undefined;
    }
    return doc.document.toString();
  }

  /**
   * Apply a workspace edit to every open Markdown document named by the
   * transaction set. The document manager is the central collab authority:
   * it prepares every ChangeSet before mutating any document, records one
   * serialized authority update per touched document, then broadcasts the
   * updates for every renderer pane to pull. The review and the annotations
   * of a document follow the edit, and its sidecar holds the edited text.
   *
   * Resolving the returned promise is the application acknowledgement used
   * by ReferenceProvider. No rename success or undo record may be exposed
   * before this method has updated every named authority buffer.
   *
   * @param   {WorkspaceTextEdit[]}  edits  Open-document workspace edits
   *
   * @return  {Promise<string[]>}           Acknowledged document paths
   */
  public async applyWorkspaceTextEdits(edits: WorkspaceTextEdit[]): Promise<string[]> {
    const editsByDocument = new Map<string, WorkspaceTextEdit[]>();
    for (const edit of edits) {
      const documentEdits = editsByDocument.get(edit.documentPath);
      if (documentEdits === undefined) {
        editsByDocument.set(edit.documentPath, [edit]);
      } else {
        documentEdits.push(edit);
      }
    }

    // Every ChangeSet is made, and with that checked against its document,
    // before a buffer changes.
    const prepared: Array<{
      document: Document;
      filePath: string;
      source: Text;
      changes: ChangeSet;
    }> = [];
    for (const [filePath, documentEdits] of editsByDocument) {
      const document = this.documents.find((candidate) => candidate.filePath === filePath);
      assert(
        document !== undefined,
        `[DocumentManager] Workspace edit names unopened document ${filePath}`,
      );
      assert(
        document.type === DocumentType.Markdown,
        `[DocumentManager] Workspace edit names non-Markdown document ${filePath}`,
      );
      const changes = ChangeSet.of(
        documentEdits.map((edit) => ({
          from: edit.range.from,
          to: edit.range.to,
          insert: edit.insert,
        })),
        document.document.length,
      );
      prepared.push({ document, filePath, source: document.document, changes });
    }

    // Each document changes as it does for an update of an editor: under its
    // lock and through the collaboration service, which writes the sidecar
    // of a document with a review or annotations before the buffer changes.
    // A document that fails leaves the earlier ones changed and rejects; the
    // workspace-edit transaction then restores them.
    for (const { document, filePath, source, changes } of prepared) {
      const documentId = this.ensureDocumentId(filePath);
      await this._reviewApplication.withDocumentLock(documentId, async () => {
        assert(
          this.documents.includes(document) && document.document === source,
          `[DocumentManager] ${filePath} changed during the workspace edit`,
        );
        const nextText = changes.apply(source);
        await this._reviewApplication.applyWorkingTextEditLocked(
          documentId,
          normalizeText(nextText.toString()),
          changes,
          () => {
            document.document = nextText;
            document.currentVersion += 1;
            document.updates.push({
              changes: serializeChangeSet(changes),
              clientID: "reference-rename",
            });
            while (document.updates.length > MAX_VERSION_HISTORY) {
              document.updates.shift();
              document.minimumVersion += 1;
            }
            this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
              filePath,
              status: "modification",
            });
            this._app.references.reportAuthorityBuffer(filePath);
          },
        );
      });
    }

    return prepared.map((transaction) => transaction.filePath);
  }

  /**
   * The DocumentCollaborationSession every renderer pane and the
   * annotations panel read, built by the one pure constructor of that shape
   * (review-diff-store.ts's collaborationSessionFor) so a spec can prove the
   * same merge production broadcasts. `undefined` only when the document
   * itself is not open — annotations and review are each a real
   * empty/absent answer on their own, never a reason to skip the broadcast.
   */
  private _collaborationSessionFor(
    documentId: string,
    filePath: string,
  ): DocumentCollaborationSession | undefined {
    const document = this.documents.find((candidate) => candidate.filePath === filePath);
    if (document === undefined) {
      return undefined;
    }
    return collaborationSessionFor({
      documentId,
      documentPath: filePath,
      workingText: document.document.toString(),
      review: this._reviewApplication.getReview(documentId),
      annotations: this._reviewApplication.getAnnotations(documentId),
    });
  }

  /**
   * Workspace-wide collaboration projection for the annotations panel.
   *
   * Open documents use the same live session every editor pane receives.
   * Closed documents are projected from their validated collaboration
   * sidecars into that exact same renderer shape. The renderer never reads
   * sidecars directly and never has to know whether a document is open.
   *
   * A sidecar that cannot be read hides no other document: the listing
   * names the file, and the document of the file when `paths` holds it.
   *
   * A sidecar outside `paths` is the state of a document that the window
   * does not list. The listing names it when its document has no file
   * (_sidecarsOfNoDocument).
   */
  private async _workspaceCollaborationSessions(
    paths: readonly string[],
  ): Promise<WorkspaceCollaborationListing> {
    const wanted = new Set(paths);
    const sessions: DocumentCollaborationSession[] = [];
    const livePaths = new Set<string>();

    // Read live authority state first. No document id is allocated merely
    // because a workspace contains a file with no collaboration state.
    for (const filePath of wanted) {
      const documentId = this.getDocumentId(filePath);
      if (documentId === undefined) {
        continue;
      }
      const live = this._collaborationSessionFor(documentId, filePath);
      if (live !== undefined) {
        sessions.push(live);
        livePaths.add(filePath);
      }
    }

    // Enumerate the small set of sidecars once, then intersect it with the
    // workspace. This avoids one failed filesystem lookup per ordinary file.
    const { sidecars, unreadable } = await this._reviewApplication.collaborationSidecarInventory();
    const unlisted: string[] = [];
    for (const sidecar of sidecars) {
      if (livePaths.has(sidecar.documentPath)) {
        continue;
      }
      if (!wanted.has(sidecar.documentPath)) {
        unlisted.push(sidecar.documentPath);
        continue;
      }
      const documentId = this.ensureDocumentId(sidecar.documentPath);
      sessions.push(
        collaborationSessionFor({
          documentId,
          documentPath: sidecar.documentPath,
          workingText: sidecar.workingText,
          review: sidecar.review === null ? undefined : reviewFromSidecar(documentId, sidecar),
          annotations: sidecar.annotations,
        }),
      );
    }
    return {
      sessions,
      unreadable: this._documentsOfUnreadableFiles(unreadable, wanted),
      ownerless: await this._sidecarsOfNoDocument(unlisted),
    };
  }

  /**
   * Of the given document paths, each of which has a sidecar, the ones
   * where the application reaches no file: the author deleted the document,
   * or a move of the document could not carry the state to its new path.
   *
   * Only a path in an open workspace that is there counts. The file of a
   * workspace on a volume that is not mounted is not a deleted document,
   * and the application knows nothing of a file outside every workspace. A
   * document that is loaded keeps its state for as long as it is loaded.
   */
  private async _sidecarsOfNoDocument(
    documentPaths: readonly string[],
  ): Promise<OwnerlessCollaborationFile[]> {
    const { openWorkspaces } = this._app.config.get().app;
    const loaded = new Set(this.documents.map((document) => document.filePath));
    const rootIsThere = new Map<string, boolean>();
    const ownerless: OwnerlessCollaborationFile[] = [];
    for (const documentPath of documentPaths) {
      const root = innermostRoot(documentPath, openWorkspaces);
      if (root === undefined || loaded.has(documentPath)) {
        continue;
      }
      if (!rootIsThere.has(root)) {
        rootIsThere.set(root, await this._app.fsal.testAccess(root, FSConstants.F_OK));
      }
      if (
        rootIsThere.get(root) === true &&
        !(await this._app.fsal.testAccess(documentPath, FSConstants.F_OK))
      ) {
        ownerless.push({
          file: this._reviewApplication.sidecarFileOf(documentPath),
          documentPath,
        });
      }
    }
    return ownerless;
  }

  /**
   * The name of a sidecar file is a hash of the path of its document, so the
   * document of an unreadable file is known only among the given paths. The
   * hashes are computed only when a file is unreadable.
   */
  private _documentsOfUnreadableFiles(
    unreadable: ReadonlyArray<{ file: string; cause: string }>,
    paths: ReadonlySet<string>,
  ): UnreadableCollaborationFile[] {
    if (unreadable.length === 0) {
      return [];
    }
    const documentOfFile = new Map(
      [...paths].map((filePath) => [this._reviewApplication.sidecarFileOf(filePath), filePath]),
    );
    return unreadable.map((entry) => ({ ...entry, documentPath: documentOfFile.get(entry.file) }));
  }

  /**
   * Replace the live document text through the authority's own prepare/commit
   * pair. Used by the lifecycle paths that own their own persistence —
   * discard and reattach — where the text is not a review decision's output.
   */
  private _applyWorkingTextToDocument(filePath: string, workingText: string): void {
    const documentId = this.getDocumentId(filePath);
    if (documentId === undefined) {
      return;
    }
    this.commitWorkingTextReplacement(this.prepareWorkingTextReplacement(documentId, workingText));
  }
}
