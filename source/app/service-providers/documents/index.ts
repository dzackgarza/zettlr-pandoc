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

import { ChangeSet, Text } from '@codemirror/state'
import { trans } from '@common/i18n-main'
import { markdownToAST } from '@common/modules/markdown-utils'
import PersistentDataContainer from '@common/modules/persistent-data-container'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import { countAll } from '@common/util/counter'
import errorToString from '@common/util/error-to-string'
import isFile from '@common/util/is-file'
import serializeChangeSet from '@common/util/serialize-change-set'
import {
  type BranchNodeJSON,
  DocumentType,
  DP_EVENTS,
  type LeafNodeJSON,
  type OpenDocument,
  type SerializedUpdate,
} from '@dts/common/documents'
import {
  SAVE_REFUSED_CHANNEL,
  type SaveFileResult,
  type SaveRefusal,
  type SaveRefusedBroadcast,
} from '@dts/common/documents'
import type { AnyDescriptor, CodeFileDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import type {
  DocumentLocation,
  SourceRange,
  WorkspaceTextEdit,
} from '@dts/common/references'
import type {
  AgentErrorCode,
  AgentEvent,
  AgentEventType,
  ProposalClaim,
} from '@dts/common/agent-api'
import type {
  AnnotationActor,
  AnnotationMessage,
  TextAnnotation,
} from '@dts/common/annotation-domain'
import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import { type TabManager } from '@providers/documents/document-tree/tab-manager'
import type { ConfigOptions } from '@providers/config/get-config-template'
import ProviderContract, { type IPCMessage } from '@providers/provider-contract'
import { IpcListener } from '@electron-toolkit/typed-ipc/main'
import { strict as assert } from 'assert'
import { randomUUID } from 'crypto'
import { app, type BrowserWindow, dialog, ipcMain, type MessageBoxOptions, shell } from 'electron'
import EventEmitter from 'events'
import { constants as FSConstants } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { normalizeText } from './review-diff-store'
import { sha256Text } from '@common/util/sha256'
import {
  getDocumentTypeForExtension,
  hasImageExt,
  hasMdOrCodeExt,
  hasPDFExt,
} from 'source/common/util/file-extention-checks'
import isDir from 'source/common/util/is-dir'
import { v4 as uuid4 } from 'uuid'
import { type AppServiceContainer } from '../../app-service-container'
import { DocumentTree, type DTLeaf } from './document-tree'
import {
  type ReviewStatus,
  collaborationSessionFor,
} from './review-diff-store'
import {
  CollaborationApplicationService,
  type AgentEventPayload,
  type AnnotationFailure,
  type PreparedDocumentMutation,
  type CollaborationDocumentAuthority,
  type ReviewFailure,
  type ReviewMutationPrecondition,
  type ReviewQueryPort,
  type ReviewSavePreparation,
  type SubmittedProposal,
} from './document-collaboration-application-service'
import {
  type AcceptAllChunksResponse,
  type AddReviewCommentResponse,
  type ChunkCommentResponse,
  type ChunkDecision,
  type ChunkDecisionResponse,
  type ClearReviewResponse,
  type RetractProposalResponse,
} from './review-transitions'

type DocumentWindows = Record<string, DocumentTree>
type DocumentWindowsJSON = Record<string, BranchNodeJSON|LeafNodeJSON>

interface DocumentWatchdog {
  on(event: 'change', listener: (event: unknown, filePath: unknown) => void): void
  getWatched(): Record<string, string[]>
  watchPath(filePath: string): void
  unwatchPath(filePath: string): void
  shutdown(): Promise<void>
}

type DocumentManagerConfig = {
  get(): {
    app: Pick<ConfigOptions['app'], 'openFiles' | 'openWorkspaces'>
    editor: Pick<ConfigOptions['editor'], 'autoSave'>
    system: Pick<ConfigOptions['system'], 'avoidNewTabs'>
    appLang: ConfigOptions['appLang']
    files: {
      images: Pick<ConfigOptions['files']['images'], 'openWith'>
      pdf: Pick<ConfigOptions['files']['pdf'], 'openWith'>
    }
    alwaysReloadFiles: ConfigOptions['alwaysReloadFiles']
  }
  addPath: AppServiceContainer['config']['addPath']
  set: AppServiceContainer['config']['set']
}

type DocumentManagerApp = {
  citeproc: Pick<AppServiceContainer['citeproc'], 'synchronizeDatabases'>
  config: DocumentManagerConfig
  fsal: {
    getWatchdog(): DocumentWatchdog
    getFilesystemMetadata(filePath: string): Promise<{ modtime: number }>
    getAllLoadedDescriptors?(): Promise<AnyDescriptor[]>
  } & Pick<
    AppServiceContainer['fsal'],
    | 'getDescriptorFor'
    | 'getDescriptorForAnySupportedFile'
    | 'loadAnySupportedFile'
    | 'readDirectoryRecursively'
    | 'testAccess'
    | 'writeTextFile'
  >
  log: Pick<AppServiceContainer['log'], 'error' | 'info' | 'verbose' | 'warning'>
  recentDocs: Pick<AppServiceContainer['recentDocs'], 'add'>
  /**
   * The live-reference seam of the references provider (issue #53): this
   * manager is the document authority and DRIVES the provider's live
   * overlay at its own mutation points — load/change reports and
   * close/move/reload drops. The provider reads the buffer text back
   * through readMarkdownBufferContent().
   */
  references: {
    reportAuthorityBuffer: (filePath: string, immediate?: boolean) => void
    dropAuthorityBuffer: (filePath: string) => void
  }
  stats: Pick<AppServiceContainer['stats'], 'updateCounts'>
  windows: Pick<
    AppServiceContainer['windows'],
    'askSaveChanges' | 'getFirstMainWindow' | 'getMainWindowKey'
  >
}

// Keep no more than this many updates.
const MAX_VERSION_HISTORY = 100
// Delayed timeout means: Save after 5 seconds
const DELAYED_SAVE_TIMEOUT = 5000
// Even "immediate" should not save immediately to prevent race conditions on slower systems
const IMMEDIATE_SAVE_TIMEOUT = 500

export interface DocumentsUpdateContext {
  windowId?: string
  leafId?: string
  filePath?: string
  direction?: 'horizontal'|'vertical'
  insertion?: 'after'|'before'
  newLeaf?: string
  originLeaf?: string
  key?: string
  status?: 'modification'|'pinned'
  /**
   * Additive (issue #1 Phase 5): the exact DocumentLocation to restore in
   * the renderer when a Back/Forward navigation restored a stamped history
   * entry. Only ever present on ACTIVE_FILE events.
   */
  location?: DocumentLocation
  /**
   * Additive (issue #1 Phase 5): the definition range to land on after a
   * cross-file reference jump. Only ever present on ACTIVE_FILE events.
   */
  targetRange?: SourceRange
  /**
   * A document's whole collaboration state — its annotations, and its
   * review if one is active — as one snapshot. Broadcast on every
   * annotation and review mutation (DP_EVENTS.DOCUMENT_COLLABORATION); the
   * renderer's document-collaboration Pinia store is the only reader.
   */
  collaborationSession?: DocumentCollaborationSession
  /**
   * The renderer-ready failure payload for FILE_REMOTE_CHANGE_ERROR events.
   * The message is suitable for the visible error surface; diagnostic retains
   * the complete stack or serialized rejection for renderer diagnostics.
   */
  documentLoadError?: {
    message: string
    diagnostic: string
  }
}

/**
 * Holds all information associated with a document that is currently loaded
 */
interface Document {
  /**
   * Opaque document identifier. Stable for the lifetime of
   * a loaded document; used as the key for all agent API operations.
   */
  documentId: string
  /**
   * The absolute path to the file
   */
  filePath: string
  /**
   * The descriptor for the file
   */
  descriptor: MDFileDescriptor|CodeFileDescriptor
  /**
   * The file type (e.g. Markdown, JSON, YAML)
   */
  type: DocumentType
  /**
   * The current version of the document in memory
   */
  currentVersion: number
  /**
   * The last version for which full updates are available. Editors with a
   * version less than minimumVersion will need to reload the document.
   */
  minimumVersion: number
  /**
   * The last version number that has been saved to disk. If lastSavedVersion
   * === currentVersion, the file is not modified. NOTE: DO NOT ASSUME THIS
   * VARIABLE TO ACCURATELY REFLECT THE PRECISE VERSION THAT HAS BEEN SAVED;
   * THIS VARIABLE MAY DIFFER, AND EVEN GET NEGATIVE! ONLY USE THIS TO COMPARE
   * AGAINST CURRENTVERSION!
   */
  lastSavedVersion: number
  /**
   * This is a duplicate of whatever has been last written to disk. It is used
   * to double check whether a change event actually changed the content of a
   * file or if the file remains the same on disk as in buffer.
   */
  lastSavedContent: string
  /**
   * Holds all updates between minimumVersion and currentVersion in a granular
   * form.
   */
  updates: SerializedUpdate[]
  /**
   * The actual document text in a CodeMirror format.
   */
  document: Text
  /**
   * Necessary for the word count statistics: The amount of words when the file
   * was last saved to disk.
   */
  lastSavedWordCount: number
  /**
   * Necessary for the word count statistics: The amount of characters when the
   * file was last saved to disk.
   */
  lastSavedCharCount: number
  /**
   * Holds an optional save timeout. This is for when users have indicated they
   * want autosaving.
   */
  saveTimeout: undefined|NodeJS.Timeout
}

export type DocumentAuthorityIPCContract = {
  'get-document': {
    request: { payload: { filePath: string } }
    response: { content: string; type: DocumentType; startVersion: number }
  }
  'pull-updates': {
    request: { payload: { filePath: string; version: number } }
    response: SerializedUpdate[] | false
  }
  'push-updates': {
    request: { payload: { filePath: string; version: number; updates: SerializedUpdate[] } }
    response: boolean
  }
}

export type DocumentAuthorityIPCAPI = IPCMessage<DocumentAuthorityIPCContract>

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
} from '@dts/common/documents'
export { SAVE_REFUSED_CHANNEL } from '@dts/common/documents'

// Most document manager commands require a leaf location, described by the
// window and leaf IDs.
type LeafLoc = { windowId: string; leafId: string }
export type DocumentManagerIPCContract = {
  'set-pinned': {
    request: { payload: LeafLoc & { path: string; pinned: boolean } }
    response: undefined
  }
  'retrieve-tab-config': {
    request: { payload: { windowId: string } }
    response: LeafNodeJSON | BranchNodeJSON
  }
  // targetRange/sourceLocation are additive (issue #1 Phase 5): a reference
  // jump lands on targetRange in the opened document and stamps the origin
  // pane's current history entry with sourceLocation so Back can restore it.
  // windowId/leafId/newTab are optional, exactly like the corresponding
  // openFile() parameters: callers such as the sidebar and renderers open
  // files without naming a pane and let the manager pick one.
  'open-file': {
    request: {
      payload: {
        path: string
        windowId?: string
        leafId?: string
        newTab?: boolean
        targetRange?: SourceRange
        sourceLocation?: DocumentLocation
      }
    }
    response: boolean
  }
  'close-file': {
    request: { payload: LeafLoc & { path: string } }
    response: boolean
  }
  'close-file-everywhere': {
    request: { payload: { path: string } }
    response: undefined
  }
  'get-open-workspace-files': {
    request: { payload: { path: string } }
    response: string[]
  }
  'sort-open-files': {
    request: { payload: LeafLoc & { newOrder: string[] } }
    response: undefined
  }
  'get-file-modification-status': {
    request: { payload?: undefined }
    response: string[]
  }
  // The store's hydration pull: one caller resolves it and caches the
  // result, every other pane of the same path reads the cache. Every
  // subsequent update reaches the store through the broadcast alone.
  'get-collaboration-session': {
    request: { payload: { path: string } }
    response: DocumentCollaborationSession | undefined
  }
  'move-file': {
    request: {
      payload: {
        originWindow: string
        targetWindow: string
        originLeaf: string
        targetLeaf: string
    path: string
  }
    }
    response: undefined
  }
  'split-leaf': {
    request: {
      payload: {
        originWindow: string
        originLeaf: string
        direction: 'horizontal' | 'vertical'
        insertion: 'before' | 'after'
        path?: string
        fromWindow?: string
    fromLeaf?: string
  }
    }
    response: undefined
  }
  'close-leaf': { request: { payload: LeafLoc }; response: undefined }
  'focus-leaf': { request: { payload: LeafLoc }; response: undefined }
  'set-branch-sizes': {
    request: { payload: { windowId: string; branchId: string; sizes: number[] } }
    response: undefined
  }
  // location is additive (issue #1 Phase 5): the current DocumentLocation of
  // the navigating pane, stamped onto the current history entry before the
  // move so the opposite direction can restore it.
  'navigate-forward': {
    request: { payload: LeafLoc & { location?: DocumentLocation } }
    response: undefined
  }
  'navigate-back': {
    request: { payload: LeafLoc & { location?: DocumentLocation } }
    response: undefined
  }
  // Additive (issue #1 Phase 5): whether the leaf's session history has
  // entries before/after the pointer (Back/Forward enabled state).
  'get-navigation-state': {
    request: { payload: LeafLoc }
    response: { canGoBack: boolean; canGoForward: boolean }
  }
}

export type DocumentManagerIPCAPI = IPCMessage<DocumentManagerIPCContract>

/** The document to save. */
export interface SaveFileInput {
  path: string
}

/** One chunk decision, fenced on the generation and working text it was formed against. */
export type ReviewDecisionInput = {
  reviewId: string
  chunkId: string
  decision: ChunkDecision
} & ReviewMutationPrecondition

/**
 * A comment attached to one outstanding suggestion without deciding it.
 * The stable suggestion id selects the comment owner.
 */
export type ReviewChunkCommentInput = {
  reviewId: string
  chunkId: string
  text: string
} & ReviewMutationPrecondition

/** Accepting every remaining chunk, under the same fence one decision uses. */
export type ReviewAcceptAllInput = { reviewId: string } & ReviewMutationPrecondition

/** Discarding a review, under the same fence one decision uses. */
export type ReviewClearInput = { reviewId: string } & ReviewMutationPrecondition

/**
 * A comment adjudicates nothing and moves no text, so it fences on the review
 * generation alone.
 */
export interface ReviewCommentInput {
  reviewId: string
  text: string
  expectedReviewGeneration: number
}

/**
 * The owner comments on a selection. `path` resolves to the loaded
 * document's documentId inside the handler; there is no `actor` field here
 * because the renderer's owner-facing channel is the only caller and the
 * handler hardcodes `'owner'` — an agent has no path to this channel at all.
 */
export interface CreateAnnotationIpcInput {
  path: string
  from: number
  to: number
  instruction: string
  expectedAnnotationGeneration: number
}

/** One more turn of an annotation thread, posted by the owner. */
export interface AddAnnotationMessageIpcInput {
  path: string
  annotationId: string
  text: string
  expectedAnnotationGeneration: number
}

/** The shape shared by resolve, reopen, and delete: an id and a fence. */
export interface AnnotationLifecycleIpcInput {
  path: string
  annotationId: string
  expectedAnnotationGeneration: number
}

/** Reattach carries the owner's freshly picked range alongside the id. */
export interface ReattachAnnotationIpcInput {
  path: string
  annotationId: string
  from: number
  to: number
  expectedAnnotationGeneration: number
}

/**
 * The document operations the renderer invokes on their own typed channels,
 * one handler signature each. This provider owns the schema; the renderer
 * bridge composes it, so a wrong payload or a changed return type is a
 * compile error at the call site with no second map to keep in step.
 */
export type DocumentIpcHandlers = {
  'documents:save-file': (input: SaveFileInput) => SaveFileResult
  'documents:decide-review-chunk': (
    input: ReviewDecisionInput,
  ) => ChunkDecisionResponse | ReviewFailure
  'documents:comment-review-chunk': (
    input: ReviewChunkCommentInput,
  ) => ChunkCommentResponse | ReviewFailure
  'documents:accept-all-review-chunks': (
    input: ReviewAcceptAllInput,
  ) => AcceptAllChunksResponse | ReviewFailure
  'documents:clear-review': (input: ReviewClearInput) => ClearReviewResponse | ReviewFailure
  'documents:add-review-comment': (
    input: ReviewCommentInput,
  ) => AddReviewCommentResponse | ReviewFailure
  'documents:create-annotation': (
    input: CreateAnnotationIpcInput,
  ) => TextAnnotation | AnnotationFailure
  'documents:add-annotation-message': (
    input: AddAnnotationMessageIpcInput,
  ) => AnnotationMessage | AnnotationFailure
  'documents:resolve-annotation': (
    input: AnnotationLifecycleIpcInput,
  ) => TextAnnotation | AnnotationFailure
  'documents:reopen-annotation': (
    input: AnnotationLifecycleIpcInput,
  ) => TextAnnotation | AnnotationFailure
  'documents:reattach-annotation': (
    input: ReattachAnnotationIpcInput,
  ) => TextAnnotation | AnnotationFailure
  'documents:delete-annotation': (
    input: AnnotationLifecycleIpcInput,
  ) => TextAnnotation | AnnotationFailure
}

export default class DocumentManager
  extends ProviderContract
  implements CollaborationDocumentAuthority
{
  /**
   * This array holds all open windows, here represented as document trees
   *
   * @var {DocumentTree[]}
   */
  private readonly _windows: DocumentWindows
  /**
   * The event emitter helps broadcast events across the main process
   *
   * @var {EventEmitter}
   */
  private readonly _emitter: EventEmitter
  /**
   * The config file container persists the document tree data to disk so that
   * open editor panes & windows can be restored
   *
   * @var {PersistentDataContainer<DocumentWindowsJSON>}
   */
  private readonly _config: PersistentDataContainer<DocumentWindowsJSON>
  /**
   * The process that watches currently opened files for remote changes
   *
   * @var {chokidar.FSWatcher}
   */
  private readonly _watcher: DocumentWatchdog

  /**
   * Holds a list of strings for files that have recently been saved by the
   * user. For those files, we need to ignore remote changes since they
   * originate here.
   *
   * @var {string[]}
   */
  private readonly _ignoreChanges: string[]

  /**
   * This array allows us to prevent showing multiple "Reload changes?" dialogs
   * for a single file open in the app.
   *
   * @var {string[]}
   */
  private readonly _remoteChangeDialogShownFor: string[]

  /**
   * Paths whose most recent remote reload failure has already been surfaced.
   * Watchdog duplicate events must not produce duplicate renderer toasts.
   *
   * @var {string[]}
   */
  private readonly _remoteChangeErrorShownFor: string[]

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
  public readonly agentEvents = new EventEmitter()

  /** Path → documentId mapping for agent API lookups. */
  private readonly _documentIdByPath: Map<string, string>

  /**
   * The one owner of a document's collaboration transactions — its review
   * and its annotations: per-document locking, persist-before-commit
   * ordering, and committed-event emission. Every mutation of either half,
   * from every transport, runs through it, and one sidecar per document (in
   * app data, keyed by canonical path) is what it writes through to.
   */
  private readonly _reviewApplication: CollaborationApplicationService

  /**
   * This holds all currently opened documents somewhere across the app.
   *
   * @var {Document[]}
   */
  private readonly documents: Document[]

  private _shuttingDown: boolean

  /** True while the before-quit save-or-discard dialog is unanswered. */
  private _quitPromptOpen: boolean

  private readonly _lastEditor: {
    windowId: string|undefined
    leafId: string|undefined
  }

  constructor(private readonly _app: DocumentManagerApp) {
    super()

    const containerPath = path.join(app.getPath('userData'), 'documents.yaml')

    this._windows = {}
    this._emitter = new EventEmitter()
    this._config = new PersistentDataContainer(containerPath, 'yaml')
    this._ignoreChanges = []
    this._remoteChangeDialogShownFor = []
    this._remoteChangeErrorShownFor = []
    this._reviewApplication = new CollaborationApplicationService({
      authority: this,
      sidecarDirectory: path.join(app.getPath('userData'), 'review-sidecars'),
      emit: (event, payload) => {
        this.emitAgentEvent(event, payload)
      },
      warn: (message) => {
        this._app.log.warning(`[DocumentManager] ${message}`)
      },
    })
    this._documentIdByPath = new Map()
    this.documents = []
    this._shuttingDown = false
    this._quitPromptOpen = false
    this._lastEditor = {
      windowId: undefined,
      leafId: undefined,
    }

    // Start up the chokidar process
    this._watcher = this._app.fsal.getWatchdog()

    this._watcher.on('change', (event, filePath) => {
      const changeEvent: unknown = event
      const changedPath: unknown = filePath
      if (typeof changedPath !== 'string') {
        this._app.log.warning('[DocumentManager] Ignoring watchdog change with a non-string path.')
        return
      }
      if (changeEvent !== 'unlink' && changeEvent !== 'change') {
        this._app.log.warning(
          `[DocumentManager] Received unexpected event ${String(changeEvent)} for ${changedPath}.`,
        )
        return
      }
      if (this._ignoreChanges.includes(changedPath) && changeEvent === 'change') {
        this._app.log.info(`[DocumentManager] Ignoring change for ${changedPath}`)
        this._ignoreChanges.splice(this._ignoreChanges.indexOf(changedPath), 1)
        return
      } else {
        this._app.log.info(`[DocumentManager] Processing ${changeEvent} for ${changedPath}`)
      }

      if (changeEvent === 'unlink') {
        // Close the file everywhere
        this.closeFileEverywhere(changedPath).catch((err: unknown) =>
          this._app.log.error(err instanceof Error ? err.message : String(err)),
        )
      } else {
        this.handleRemoteChange(changedPath).catch((err: unknown) => {
          if (this._remoteChangeErrorShownFor.includes(changedPath)) {
            return
          }
          this._remoteChangeErrorShownFor.push(changedPath)
          setTimeout(() => {
            const index = this._remoteChangeErrorShownFor.indexOf(changedPath)
            if (index >= 0) {
              this._remoteChangeErrorShownFor.splice(index, 1)
            }
          }, 1000)

          const diagnostic = errorToString(err)
          this._app.log.error(
            `[DocumentManager] Could not reload changed file ${changedPath}`,
            err,
          )
          this.broadcastEvent(DP_EVENTS.FILE_REMOTE_CHANGE_ERROR, {
            filePath: changedPath,
            documentLoadError: {
              message: err instanceof Error ? err.message : diagnostic,
              diagnostic,
            },
          })
        })
      }
    })

    /**
     * Hook the event listener that directly communicates with the editors
     */
    ipcMain.handle('documents-authority', async (event, message: DocumentAuthorityIPCAPI) => {
      const { command, payload } = message
      // Loading a document reattaches its sidecar, and an authority update
      // rewrites the reviewed working text: both are review writers, so both
      // take the same per-document lock every other writer takes.
      switch (command) {
        case 'pull-updates':
          return await this.pullUpdates(payload.filePath, payload.version)
        case 'push-updates':
          return await this.pushUpdates(payload.filePath, payload.version, payload.updates)
        case 'get-document':
          return await this._reviewApplication.withDocumentLock(
            this.ensureDocumentId(payload.filePath),
            async () => await this.getDocument(payload.filePath),
          )
      }
    })

    // The document operations the renderer drives on their own channels. Each
    // one is a single typed handler, so the payload and the response are the
    // handler's own signature rather than a branch of a multiplexer.
    const operations = new IpcListener<DocumentIpcHandlers>()
    operations.handle('documents:save-file', async (_event, input) => {
      return await this.saveFile(input.path)
    })
    operations.handle('documents:decide-review-chunk', async (_event, input) => {
      const { reviewId, chunkId, decision, ...precondition } = input
      return await this.decideReviewChunk(reviewId, chunkId, decision, precondition)
    })
    operations.handle('documents:comment-review-chunk', async (_event, input) => {
      const { reviewId, chunkId, text, ...precondition } = input
      return await this.commentReviewChunk(reviewId, chunkId, text, precondition)
    })
    operations.handle('documents:accept-all-review-chunks', async (_event, input) => {
      const { reviewId, ...precondition } = input
      return await this.acceptAllReviewChunks(reviewId, precondition)
    })
    operations.handle('documents:clear-review', async (_event, input) => {
      const { reviewId, ...precondition } = input
      return await this.clearReview(reviewId, precondition)
    })
    operations.handle('documents:add-review-comment', async (_event, input) => {
      return await this.addReviewComment(input.reviewId, input.text, input.expectedReviewGeneration)
    })
    // The owner-facing annotation channels. Each resolves `path` to a
    // documentId before touching the application service, and each
    // hardcodes 'owner' as the actor — the renderer has no field to smuggle
    // a different actor through, since the input types above declare none.
    operations.handle('documents:create-annotation', async (_event, input) => {
      const documentId = this.getDocumentId(input.path)
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path)
      }
      return await this.createAnnotation(
        documentId, 'owner', input.from, input.to, input.instruction, input.expectedAnnotationGeneration,
      )
    })
    operations.handle('documents:add-annotation-message', async (_event, input) => {
      const documentId = this.getDocumentId(input.path)
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path)
      }
      return await this.addAnnotationMessage(
        documentId, input.annotationId, 'owner', input.text, undefined, input.expectedAnnotationGeneration,
      )
    })
    operations.handle('documents:resolve-annotation', async (_event, input) => {
      const documentId = this.getDocumentId(input.path)
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path)
      }
      return await this.resolveAnnotation(documentId, input.annotationId, 'owner', input.expectedAnnotationGeneration)
    })
    operations.handle('documents:reopen-annotation', async (_event, input) => {
      const documentId = this.getDocumentId(input.path)
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path)
      }
      return await this.reopenAnnotation(documentId, input.annotationId, 'owner', input.expectedAnnotationGeneration)
    })
    operations.handle('documents:reattach-annotation', async (_event, input) => {
      const documentId = this.getDocumentId(input.path)
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path)
      }
      return await this.reattachAnnotation(
        documentId, input.annotationId, 'owner', input.from, input.to, input.expectedAnnotationGeneration,
      )
    })
    operations.handle('documents:delete-annotation', async (_event, input) => {
      const documentId = this.getDocumentId(input.path)
      if (documentId === undefined) {
        return this._annotationDocumentNotFound(input.path)
      }
      return await this.deleteAnnotation(documentId, input.annotationId, 'owner', input.expectedAnnotationGeneration)
    })

    // Finally, listen to events from the renderer
    ipcMain.handle('documents-provider', async (event, message: DocumentManagerIPCAPI) => {
      const { command, payload } = message
      switch (command) {
        // A given tab should be set as pinned
        case 'set-pinned': {
          const { windowId, leafId, path, pinned } = payload
          this.setPinnedStatus(windowId, leafId, path, pinned)
          return
        }
        // Some main window has requested its tab/split view state
        case 'retrieve-tab-config': {
          return this._windows[payload.windowId].toJSON()
        }
        case 'open-file': {
          const { windowId, leafId, path, newTab, targetRange, sourceLocation } = payload
          return await this.openFile(windowId, leafId, path, newTab, {
            targetRange,
            sourceLocation,
          })
        }
        case 'close-file': {
          const { windowId, leafId, path } = payload
          return await this.closeFile(windowId, leafId, path)
        }
        case 'close-file-everywhere': {
          const { path } = payload
          return this.closeFileEverywhere(path)
        }
        case 'get-open-workspace-files': {
          const { path } = payload
          return this.getFilesForWorkspace(path)
        }
        case 'sort-open-files': {
          const { windowId, leafId, newOrder } = payload
          this.sortOpenFiles(windowId, leafId, newOrder)
          return
        }
        case 'get-file-modification-status': {
          return this.documents.filter((x) => this.isModified(x.filePath)).map((x) => x.filePath)
        }
        case 'get-collaboration-session': {
          const docId = this.getDocumentId(payload.path)
          return docId === undefined ? undefined : this._collaborationSessionFor(docId, payload.path)
        }
        case 'move-file': {
          const {
            originWindow, originLeaf, targetWindow, targetLeaf, path
          } = payload
          return await this.moveFile(
            originWindow, targetWindow, originLeaf, targetLeaf, path
          )
        }
        case 'split-leaf': {
          const {
            originWindow, originLeaf,
            direction, insertion,
            path,
            fromWindow, fromLeaf
          } = payload

          return await this.splitLeaf(
            originWindow, originLeaf,
            direction, insertion,
            path,
            fromWindow,
            fromLeaf,
          )
        }
        case 'close-leaf': {
          return this.closeLeaf(payload.windowId, payload.leafId)
        }
        case 'focus-leaf': {
          return this._updateFocusLeaf(payload.windowId, payload.leafId)
        }
        case 'set-branch-sizes': {
          // NOTE that in this particular instance we do not emit an event. The
          // reason is that we need to prevent frequent reloads during resizing.
          // For as long as the window is open, the window will have the correct
          // sizes, and will only update those sizes here in the main process.
          // As soon as the window is closed, however, it will automatically
          // grab the correct sizes again.
          const branch = this._windows[payload.windowId].findBranch(payload.branchId)
          if (branch !== undefined) {
            branch.sizes = payload.sizes
            this.syncToConfig()
          }
          return
        }
        case 'navigate-forward': {
          return await this.navigateForward(payload.windowId, payload.leafId, payload.location)
        }
        case 'navigate-back': {
          return await this.navigateBack(payload.windowId, payload.leafId, payload.location)
        }
        case 'get-navigation-state': {
          return this.getNavigationState(payload.windowId, payload.leafId)
        }
      }
    })

    // Listen to the before-quit event by which we make sure to only quit the
    // application if the status of possibly modified files has been cleared.
    // We listen to this event, because it will fire *before* the process
    // attempts to close the open windows, including the main window, which
    // would result in a loss of data. NOTE: The exception is the auto-updater
    // which will close the windows before this event. But because we also
    // listen to close-events on the main window, we should be able to handle
    // this, if we ever switched to the auto updater.
    app.on('before-quit', (event) => {
      if (!this.isClean()) {
        event.preventDefault()

        // Re-entrancy guard: quit can be requested again while the prompt is
        // open (window-all-closed after the last window dies, the tray, a
        // second Ctrl+Q). Without it, each request stacks another identical
        // dialog over the unanswered first one.
        if (this._quitPromptOpen) {
          return
        }
        this._quitPromptOpen = true

        // NOTE: We are re-implementing `askSaveChanges` here since we cannot
        // give the user the choice to cancel.
        // TODO: Once the window management logic is put here, we have better
        // control over the windows and can ask this question *before* the
        // window is being closed.
        const opt: MessageBoxOptions = {
          type: 'question',
          buttons: [
            trans('Save changes'),
            trans('Discard changes'),
            trans('Cancel')
          ],
          defaultId: 0,
          cancelId: 2,
          title: trans('Unsaved changes'),
          message: trans('There are unsaved changes. Do you want to save or discard them?'),
        }

        dialog.showMessageBox(opt)
          .then(async ({ response }) => {
            this._quitPromptOpen = false
            // 0 = Save, 1 = Don't save, 2 = Cancel
            if (response === 2) {
              this._app.log.verbose('User cancelled save-dialog; not quitting.')
              return // Do nothing
            }

            // Apply the choice to all open documents
            for (const document of this.documents) {
              if (response === 0) {
                const saved = await this.saveFile(document.filePath)
                if (!saved.ok) {
                  this._announceSaveRefusal(document.filePath, saved)
                  return
                }
              } else {
                await this._discardChanges(document)
              }
            }

            app.quit()
          })
          .catch((err) => {
            this._quitPromptOpen = false
            this._app.log.error('[DocumentManager] Cannot ask user to save or omit changes!', err)
          })
      } else {
        this._shuttingDown = true
      }
    })
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
  public async askUserToCloseWindow (windowId: string): Promise<boolean> {
    if (this.isClean(windowId)) {
      return true
    }

    // TODO: Check if the same (modified) files are also open in other windows.
    // If so, we can treat this window as if it contains no changes, since the
    // document is still open somewhere else.

    const result = await this._app.windows.askSaveChanges()
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
      for (const document of this._windowExclusiveDocuments(windowId)) {
        await this._discardChanges(document)
      }

      // If we're not shutting down, this function will only be called for when
      // the user wants to actively close a window for good
      if (!this._shuttingDown) {
        await this.closeWindow(windowId)
      }

      return true
    } else if (result.response === 0) {
      // Save this window's docs — the same set the discard branch throws away.
      for (const document of this._windowExclusiveDocuments(windowId)) {
        const saved = await this.saveFile(document.filePath)
        if (!saved.ok) {
          this._announceSaveRefusal(document.filePath, saved)
          return false
        }
      }

      // If we're not shutting down, this function will only be called for when
      // the user wants to actively close a window for good
      if (!this._shuttingDown) {
        await this.closeWindow(windowId)
      }

      return true
    } else {
      return false
    }
  }

  async boot (): Promise<void> {
    // Loads in all openFiles
    this._app.log.verbose('Document Manager starting up ...')

    // Check if the data store is initialized
    if (!(await this._config.isInitialized())) {
      this._app.log.info('[Document Manager] Initializing document storage ...')
      const tree = new DocumentTree()
      const key = uuid4()
      await this._config.init({ [key]: tree.toJSON() })
    }

    const treedata = await this._config.get()
    for (const key in treedata) {
      try {
        // Make sure to fish out invalid paths before mounting the tree
        const tree = DocumentTree.fromJSON(treedata[key])
        for (const leaf of tree.getAllLeafs()) {
          for (const file of leaf.tabMan.openFiles.map((x) => x.path)) {
            if (
              !(await this._app.fsal.testAccess(
                file,
                FSConstants.F_OK | FSConstants.W_OK | FSConstants.R_OK,
              ))
            ) {
              leaf.tabMan.closeFile(file)
            }
          }
          if (leaf.tabMan.openFiles.length === 0) {
            leaf.parent.removeNode(leaf)
          }
        }
        this._windows[key] = tree
        this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
      } catch (err: unknown) {
        if (err instanceof Error) {
          this._app.log.error(
            `[Document Provider] Could not instantiate window ${key}: ${err.message}`,
            err,
          )
        } else {
          this._app.log.error(
            `[Document Provider] Could not instantiate window ${key}: Unknown error`,
            err,
          )
        }
      }
    }

    if (Object.keys(treedata).length === 0) {
      this._app.log.warning('[Document Manager] Creating new window since all are closed.')
      const key = uuid4()
      this._windows[key] = new DocumentTree()
      this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
    }

    // Sync everything after boot
    this.syncWatchedFilePaths()
    await this.synchronizeDatabases()
    this.syncToConfig()

    this._app.log.info(`[Document Manager] Restored ${this.windowCount()} open windows.`)
  }

  public windowCount (): number {
    return Object.keys(this._windows).length
  }

  public windowKeys (): string[] {
    return Object.keys(this._windows)
  }

  public leafIds (windowId: string): string[] {
    if (!(windowId in this._windows)) {
      return []
    }

    return this._windows[windowId].getAllLeafs().map((leaf) => leaf.id)
  }

  public newWindow (): void {
    const newTree = new DocumentTree()
    const existingKeys = Object.keys(this._windows)
    let key = uuid4()
    while (existingKeys.includes(key)) {
      key = uuid4()
    }

    this._windows[key] = newTree
    this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
    this.syncToConfig()
  }

  public async closeWindow(windowId: string): Promise<void> {
    if (this._shuttingDown) {
      return // During shutdown only the WindowManager should close windows
    }

    const isLastWindow = Object.values(this._windows).length === 1

    if (windowId in this._windows && !isLastWindow) {
      // NOTE: By doing this, we always retain the window state of the last and
      // only window that is open. This means that, while additional windows
      // will be forgotten after closing, the last and final one will always
      // retain its state.
      // TODO: If we ever implement workspaces, etc., this safeguard won't be
      // necessary anymore.
      this._app.log.info(`[Documents Manager] Closing window ${windowId}!`)
      for (const document of this._windowExclusiveDocuments(windowId)) {
        try {
          await this._detachCollaboration(document.documentId)
        } catch (err) {
          this._announceDetachFailure(document.filePath, err)
          return
        }
        this.documents.splice(this.documents.indexOf(document), 1)
        this._app.references.dropAuthorityBuffer(document.filePath)
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._windows[windowId]
      this.syncToConfig()
      this.syncWatchedFilePaths()
    }
  }

  // Enable global event listening to updates of the config
  on (evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.on(evt, callback)
  }

  once (evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.once(evt, callback)
  }

  // Also do the same for the removal of listeners
  off (evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.off(evt, callback)
  }

  async shutdown (): Promise<void> {
    // We MUST under all circumstances properly call the close() function on
    // every chokidar process we utilize. Otherwise, the fsevents dylib will
    // still hold on to some memory after the Electron process itself shuts down
    // which will result in a crash report appearing on macOS.
    await this._watcher.shutdown()
    this._config.shutdown()
  }

  private broadcastEvent (event: DP_EVENTS, context?: DocumentsUpdateContext): void {
    // Here we blast an event notification across every line of code of the app
    broadcastIpcMessage('documents-update', { event, context })
    this._emitter.emit(event, context)
  }

  // DOCUMENT AUTHORITY FUNCTIONS

  public async getDocument(
    filePath: string,
  ): Promise<{ content: string; type: DocumentType; startVersion: number }> {
    const existingDocument = this.documents.find((doc) => doc.filePath === filePath)
    if (existingDocument !== undefined) {
      return {
        content: existingDocument.document.toString(),
        type: existingDocument.type,
        startVersion: existingDocument.currentVersion,
      }
    }

    // TODO: We also need to be able to load files not present in the file tree!
    const descriptor = await this._app.fsal.getDescriptorForAnySupportedFile(filePath)
    if (descriptor === undefined || descriptor.type === 'other') {
      throw new Error(`Cannot load file ${filePath}`) // TODO: Proper error handling & state recovery!
    }

    const content = await this._app.fsal.loadAnySupportedFile(filePath)

    let type = DocumentType.Markdown

    if (descriptor.type === 'code') {
      const codeDocumentType = getDocumentTypeForExtension(descriptor.path)
      if (codeDocumentType !== undefined) {
        type = codeDocumentType
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
      document: Text.of(content.split('\n')),
      lastSavedCharCount: descriptor.type === 'file' ? descriptor.charCount : 0,
      lastSavedWordCount: descriptor.type === 'file' ? descriptor.wordCount : 0,
      saveTimeout: undefined,
    }

    this.documents.push(doc)
    this.syncWatchedFilePaths()

    // Reattachment: a sidecar for this path means a review detached here.
    // On a verified fence this restores the buffer to the review's working
    // text, so the content and version returned must be read AFTER it.
    await this._reattachCollaborationSidecar(doc)

    // The authority loaded a markdown buffer: feed the references provider's
    // live overlay (issue #53). Reporting on LOAD — not only on the first
    // edit — means an open document's occurrences are part of the merged
    // reference view even when FSAL never indexed the file, and a load is
    // a single event, so it skips the typing debounce (issue #46).
    if (doc.type === DocumentType.Markdown) {
      this._app.references.reportAuthorityBuffer(filePath, true)
  }

    return {
      content: doc.document.toString(),
      type,
      startVersion: doc.currentVersion,
    }
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
    documentId: string
    documentPath: string
    wasAlreadyLoaded: boolean
  }> {
    const documentPath = this.getDocumentPath(documentId)
    if (documentPath === undefined) {
      throw new Error(`Cannot acquire document ${documentId}: no path is registered for it`)
    }
    const wasAlreadyLoaded = this.documents.some((doc) => doc.filePath === documentPath)
    if (!wasAlreadyLoaded) {
      await this.getDocument(documentPath)
    }
    return { documentId, documentPath, wasAlreadyLoaded }
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
  public async releaseTemporaryDocument(documentId: string): Promise<void> {
    const filePath = this.getDocumentPath(documentId)
    if (filePath === undefined) {
      return
    }
    const doc = this.documents.find((candidate) => candidate.filePath === filePath)
    if (doc === undefined || doc.currentVersion !== doc.lastSavedVersion) {
      return
    }
    if (this._reviewApplication.getReview(documentId) !== undefined) {
      return
    }

    let hasEditorView = false
    await this.forEachLeaf(async (tabMan) => {
      if (tabMan.openFiles.some((openFile) => openFile.path === filePath)) {
        hasEditorView = true
      }
      return false
    })
    if (hasEditorView) {
      return
    }

    this.documents.splice(this.documents.indexOf(doc), 1)
    this._app.references.dropAuthorityBuffer(filePath)
    this.syncWatchedFilePaths()
  }

  private async pullUpdates(filePath: string, clientVersion: number): Promise<SerializedUpdate[] | false> {
    const doc = this.documents.find((doc) => doc.filePath === filePath)
    if (doc === undefined) {
      // Indicate to the editor that they should get the document (again). This
      // handles the case where the document has been remotely modified and thus
      // removed from the document array.
      return false
    }

    if (clientVersion < doc.minimumVersion || clientVersion > doc.currentVersion) {
      // The client is completely out of sync and has to reload the document.
      // If this happens because clientVersion < doc.minimumVersion, this means
      // that the lost connection somehow. If it happens because clientVersion
      // > doc.currentVersion, it means that we had to roll over the version in
      // pushUpdates below.
      return false
    } else if (clientVersion < doc.currentVersion) {
      return doc.updates.slice(clientVersion - doc.minimumVersion)
    } else {
      return [] // No updates available
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
    return this._reviewApplication.withDocumentLock(
      this.ensureDocumentId(filePath),
      async () => await this.pushUpdatesLocked(filePath, clientVersion, clientUpdates),
    )
  }

  private async pushUpdatesLocked(
    filePath: string,
    clientVersion: number,
    clientUpdates: SerializedUpdate[],
  ): Promise<boolean> {
    // clientUpdates must be produced via "toJSON"
    const doc = this.documents.find((doc) => doc.filePath === filePath)
    if (doc === undefined) {
      throw new Error(`Could not receive updates for file ${filePath}: Not found.`)
    }

    if (clientVersion !== doc.currentVersion) {
      return false
    }

    // Before applying any updates, we have to clear any potential timeout so
    // that it does not interfere with us updating the document. Otherwise, this
    // can lead to a faulty state where the provider cannot save the file
    // anymore.
    clearTimeout(doc.saveTimeout)

    // The candidate document: everything the updates produce, computed
    // without touching the authority's own state.
    let candidateText = doc.document
    let candidateChanges = ChangeSet.empty(doc.document.length)
    for (const update of clientUpdates) {
      try {
      const changes = ChangeSet.fromJSON(update.changes)
        candidateText = changes.apply(candidateText)
        candidateChanges = candidateChanges.compose(changes)
      } catch (err: unknown) {
        dialog.showErrorBox(
          'Document out of sync',
          `Your modifications could not be applied to the document in memory.
This means that saving might fail. Please report this bug to us, copy the
current contents from the editor somewhere else, and restart the application.`,
        )
        throw err
      }
    }
    const candidateUpdates = [...doc.updates, ...clientUpdates]
    let candidateMinimumVersion = doc.minimumVersion
    let candidateVersion = candidateMinimumVersion + candidateUpdates.length
      // People are lazy, and hence there is a non-zero chance that in a few
      // instances the currentVersion will get dangerously close to
      // Number.MAX_SAFE_INTEGER. In that case, we need to perform a rollback to
      // version 0 and notify all editors that have the document in question
      // open to simply re-load it. That will cause a screen-flicker, but
      // honestly better like this than otherwise.
    if (candidateVersion >= Number.MAX_SAFE_INTEGER - 1) {
        console.warn(`Document ${filePath} has reached MAX_SAFE_INTEGER. Performing rollback ...`)
      candidateMinimumVersion = 0
      candidateVersion = candidateUpdates.length
        // TODO: Broadcast a message so that all editor instances can reload the
        // document.
      }
    // Drop all updates that exceed the amount of updates we allow.
    while (candidateUpdates.length > MAX_VERSION_HISTORY) {
      candidateUpdates.shift()
      candidateMinimumVersion += 1
    }

    const documentId = this.getDocumentId(filePath)
    const review = documentId === undefined ? undefined : this._reviewApplication.getReview(documentId)
    const candidateWorkingText = normalizeText(candidateText.toString())
    const commitDocument = (): void => {
      doc.document = candidateText
      doc.updates = candidateUpdates
      doc.minimumVersion = candidateMinimumVersion
      doc.currentVersion = candidateVersion
      this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
        filePath,
        status: 'modification',
      })
      if (doc.type === DocumentType.Markdown) {
        this._app.references.reportAuthorityBuffer(filePath)
      }
    }

    if (documentId !== undefined && review !== undefined) {
      await this._reviewApplication.applyWorkingTextEditLocked(
        documentId,
        candidateWorkingText,
        candidateChanges,
        commitDocument,
      )
      // A reviewed document does not autosave: the save gate owns when its
      // bytes reach disk.
      return true
    }

    commitDocument()

    const autoSave = this._app.config.get().editor.autoSave

    // No autosave
    if (autoSave === 'off') {
      return true
    }

    doc.saveTimeout = setTimeout(() => {
      this.saveFile(doc.filePath)
          .then((result) => {
            if (result.ok) {
              return
            }
            // A refusal resolves; only disk errors reject. Without this branch
            // the autosave timer swallowed refusals entirely: the review gate
            // above returns early for an open review, but a disk-changed
            // refusal reaches here, and the document stayed dirty with nothing
            // recorded anywhere. The buffer is preserved either way — this
            // makes the reason findable instead of inventing a silent success.
            const reason =
              result.refusal === undefined
                ? 'no reason reported'
                : `${result.refusal.reason}: ${result.refusal.message}`
            this._app.log.warning(
              `[Document Provider] Autosave refused for ${doc.filePath} (${reason}). ` +
                'The buffer is unchanged and still unsaved; the next explicit save will ' +
                'surface this to the user.',
            )
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            this._app.log.error(
              `[Document Provider] Could not save file ${doc.filePath}: ${message}`,
              err,
            )
          })
      },
      autoSave === 'delayed' ? DELAYED_SAVE_TIMEOUT : IMMEDIATE_SAVE_TIMEOUT,
    )

    return true
  }

  // END DOCUMENT AUTHORITY FUNCTIONS

  /**
   * This function searches all currently opened documents for files that have
   * databases attached to them, and announces to the citeproc provider that it
   * should keep those available. Resolves once the citeproc provider finishes
   * synchronizing.
   */
  private async synchronizeDatabases (): Promise<void> {
    const libraries: string[] = []

    for (const doc of this.documents) {
      if (doc.descriptor.type !== 'file') {
        continue
      }

      const frontmatter: unknown = doc.descriptor.frontmatter
      if (
        frontmatter !== null &&
        typeof frontmatter === 'object' &&
        'bibliography' in frontmatter
      ) {
        const bib = frontmatter.bibliography
        if (typeof bib === 'string' && path.isAbsolute(bib) && !libraries.includes(bib)) {
          libraries.push(bib)
        } else if (Array.isArray(bib)) {
          for (const item of bib) {
            if (typeof item === 'string' && path.isAbsolute(item) && !libraries.includes(item)) {
              libraries.push(item)
            }
          }
        }
      }
    }

    if (typeof this._app.fsal.getAllLoadedDescriptors === 'function') {
      try {
        const descriptors = await this._app.fsal.getAllLoadedDescriptors()
        for (const descriptor of descriptors) {
          if (descriptor.type === 'directory' && descriptor.settings.project?.manifest.kind === 'quarto') {
            for (const bibPath of descriptor.settings.project.manifest.bibliographies) {
              if (path.isAbsolute(bibPath) && !libraries.includes(bibPath)) {
                libraries.push(bibPath)
              }
            }
          }
        }
      } catch (err: unknown) {
        this._app.log.error('[Document Manager] Could not collect project bibliographies from FSAL', err)
      }
    }

    await this._app.citeproc.synchronizeDatabases(libraries)
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
      targetRange?: SourceRange
      sourceLocation?: DocumentLocation
    },
  ): Promise<boolean> {
    if (!isFile(filePath)) {
      // The renderer process essentially just throws paths at the documents
      // provider when the user intents to open them. Users can also link
      // folders, so we just quickly check for that, and open them (similar to
      // non-Markdown files a few lines below).
      if (isDir(filePath)) {
        await shell.openPath(filePath)
        return false
      }

      // Else: Whatever this is, it was not a proper path.
      throw new Error(`Could not open file ${filePath}: Not an existing file.`)
    }

    // Check if we can, and should, actually open the file in Zettlr. If not, we
    // need to open it via the shell externally. NOTE: This check is, to varying
    // degrees, implemented at the sources of opening-requests (read: mostly in
    // the renderers). If you see this comment, and spot a place where we
    // implemented this guard somewhere else, please refactor to simply attempt
    // to open a file path with the documents provider and defer to this check
    // here. Amend with any additional necessary checks from the other guards.
    if (!hasMdOrCodeExt(filePath)) {
      const { files } = this._app.config.get()
      let shouldOpenExternally = true
      if (hasImageExt(filePath) && files.images.openWith === 'zettlr') {
        shouldOpenExternally = false
      } else if (hasPDFExt(filePath) && files.pdf.openWith === 'zettlr') {
        shouldOpenExternally = false
      }

      if (shouldOpenExternally) {
        await shell.openPath(filePath)
        return false
      }
    }

    // If windowId is not provided, then use the last focused window
    if (windowId === undefined) {
      const mainWindow: BrowserWindow|undefined = this._app.windows.getFirstMainWindow()
      const key =
        mainWindow !== undefined ? this._app.windows.getMainWindowKey(mainWindow) : undefined
      if (key !== undefined) {
        windowId = key
      }
    }

    if (windowId === undefined) {
      this._app.log.warning(`Could not open file ${filePath}: windowId was undefined.`)
      return false
    }

    let leaf: DTLeaf|undefined
    if (leafId === undefined) {
      if (this._lastEditor.leafId !== undefined) {
        leaf = this._windows[windowId].findLeaf(this._lastEditor.leafId)
      }
      if (leaf === undefined) {
        leaf = this._windows[windowId].getAllLeafs()[0]
      }
    } else {
      leaf = this._windows[windowId].findLeaf(leafId)
    }

    if (leaf === undefined) {
      this._app.log.warning(`Could not open file ${filePath}: leaf was undefined.`)
      return false
    }

    // Now we definitely know the leaf ID if it was undefined
    if (leafId === undefined) {
      leafId = leaf.id
    }

    this._updateFocusLeaf(windowId, leafId)

    // Issue #1 Phase 5: a reference jump carries the origin location captured
    // at jump time. Stamp it onto the pane's current history entry (which
    // corresponds to the currently active file) so Back can restore it.
    const sourceLocation = navigation?.sourceLocation
    if (
      sourceLocation !== undefined &&
      leaf.tabMan.activeFile?.path === sourceLocation.documentPath
    ) {
      leaf.tabMan.updateCurrentHistoryLocation(sourceLocation)
    }

    // After here, the document will in some way be opened.
    this._app.recentDocs.add(filePath)

    const { openFiles, openWorkspaces } = this._app.config.get().app
    if (!openFiles.includes(filePath) && openWorkspaces.every((p) => !filePath.startsWith(p))) {
      // The file just opened is outside the current opened roots -> add as a
      // standalone root file.
      this._app.config.addPath(filePath)
    }

    if (leaf.tabMan.openFiles.map((x) => x.path).includes(filePath)) {
      // File is already open -> simply set it as active
      // leaf.tabMan.activeFile = filePath
      leaf.tabMan.openFile(filePath)
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId,
        leafId,
        filePath,
        targetRange: navigation?.targetRange,
      })
      this.syncToConfig()
      return true
    }

    // NOTE: Since openFile will set filePath as active, we have to retrieve the
    // (previously) active file *before* opening the new one. See bug #5065 for
    // context.
    const activeFile = leaf.tabMan.activeFile
    const ret = leaf.tabMan.openFile(filePath)
    if (ret) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId, filePath })
    }

    // Close the (formerly active) file if we should avoid new tabs and have not
    // gotten a specific request to open it in a *new* tab
    const { avoidNewTabs } = this._app.config.get().system
    if (activeFile !== null && avoidNewTabs && newTab !== true && !this.isModified(activeFile.path)) {
      leaf.tabMan.closeFile(activeFile)
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
        windowId,
        leafId,
        filePath: activeFile.path,
      })
    }

    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: leaf.tabMan.activeFile?.path,
      targetRange: navigation?.targetRange,
    })
    await this.synchronizeDatabases()
    this.syncToConfig()
    return ret
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
  public async closeFile (windowId: string, leafId: string, filePath: string): Promise<boolean> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      this._app.log.error(
        `[Document Manager] Could not close file ${filePath}: Editor pane not found.`,
      )
      return false
    }

    let numOpenInstances = 0
    await this.forEachLeaf(async (tabMan) => {
      const file = tabMan.openFiles.find((f) => f.path === filePath)
      if (file !== undefined) {
        numOpenInstances++
      }
      return false
    })

    // If we were to completely remove the file from our buffer, we have to ask
    // first. If there's at least another instance open that means that we won't
    // lose the file. NOTE: openFile will be undefined if the file has not been
    // opened in this session of Zettlr, hence it will not be modified, hence we
    // don't have to do anything.
    const openFile = this.documents.find((doc) => doc.filePath === filePath)
    if (openFile !== undefined && this.isModified(filePath) && numOpenInstances === 1) {
      const detail = trans('File: %s', openFile.descriptor.name)
      const result = await this._app.windows.askSaveChanges(detail)
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 1) {
        await this._discardChanges(openFile)
        // A saved review may survive the discard of a later edit. The
        // document is about to leave the live registry, so detach that
        // preserved review before removing its working-text resolver.
        try {
          await this._detachCollaboration(openFile.documentId)
        } catch (err) {
          this._announceDetachFailure(filePath, err)
          return false
        }
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
          filePath,
          status: 'modification',
        })
      } else if (result.response === 0) {
        const saved = await this.saveFile(filePath)
        if (!saved.ok) {
          this._announceSaveRefusal(filePath, saved)
          return false
        }
        // The save persists the review, but the final pane is leaving the
        // live registry. Detach before the splice so closed-file API reads do
        // not observe a review whose working-text authority is gone.
        try {
          await this._detachCollaboration(openFile.documentId)
        } catch (err) {
          this._announceDetachFailure(filePath, err)
          return false
        }
      } else {
        // Don't close the file
        this._app.log.info('[Document Manager] Not closing file, as the user did not want that.')
        return false
      }

      // Remove the file
      this.documents.splice(this.documents.indexOf(openFile), 1)
      this._app.references.dropAuthorityBuffer(filePath)
    } else if (openFile !== undefined && numOpenInstances === 1) {
      // The file is not modified, but this is still the last instance, so we
      // can close it without having to ask. Detach before the splice: the
      // sidecar export reads the working text through the live document.
      const _id = this.getDocumentId(filePath)
      if (_id !== undefined) {
        try {
          await this._detachCollaboration(_id)
        } catch (err) {
          this._announceDetachFailure(filePath, err)
          return false
        }
      }
      this.documents.splice(this.documents.indexOf(openFile), 1)
      this._app.references.dropAuthorityBuffer(filePath)
    }

    const ret = leaf.tabMan.closeFile(filePath)
    if (ret) {
      this.syncToConfig()
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId,
        leafId,
        filePath: leaf.tabMan.activeFile?.path,
      })
      if (leaf.tabMan.openFiles.length === 0) {
        // Remove this leaf
        leaf.parent.removeNode(leaf)
        this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId })
        this.syncToConfig()
      }

      await this.synchronizeDatabases()
    }
    return ret
  }

  /**
   * Directs every open leaf to close a given file. This function even
   * overwrites potential stati such as modification or pinned to ensure files
   * are definitely closed. This will be called from within the watcher callback
   * on an `unlink` event.
   *
   * @param   {string}  filePath  The file path in question
   */
  public async closeFileEverywhere (filePath: string): Promise<void> {
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      if (tabMan.openFiles.map((x) => x.path).includes(filePath)) {
        tabMan.setPinnedStatus(filePath, false)
        const success = tabMan.closeFile(filePath)

        if (!success) {
          return false
        }

        this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
          windowId,
          leafId,
          filePath,
        })

        if (tabMan.openFiles.length === 0) {
          this.closeLeaf(windowId, leafId)
        }
      }

      return true
    })

    // We also must splice the document out of our provider. Detach before
    // the splice: the sidecar export reads the working text through the
    // live document.
    const documentId = this.getDocumentId(filePath)
    if (documentId !== undefined) {
      try {
        await this._detachCollaboration(documentId)
      } catch (err) {
        // The file is gone from disk, so there is no reopening it to retry
        // the export; the review stays in memory and the buffer stays loaded
        // rather than being dropped along with the only copy of both.
        this._announceDetachFailure(filePath, err)
        return
      }
    }
    const idx = this.documents.findIndex((doc) => doc.filePath === filePath)
    if (idx > -1) {
      this.documents.splice(idx, 1)
      this._app.references.dropAuthorityBuffer(filePath)
    }

    this.syncWatchedFilePaths()
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
    const allPaths = await this._app.fsal.readDirectoryRecursively(workspacePath)
    // Filter: supported file extensions, and exclude the workspace directory itself
    return allPaths.filter((p) => p !== workspacePath && hasMdOrCodeExt(p) && !isDir(p))
  }

  /**
   * This function handles a remote change, i.e. where the watcher has reported
   * that the file has been changed remotely.
   *
   * @param   {string}  filePath  The file in question
   */
  private async handleRemoteChange (filePath: string): Promise<void> {
    // First thing we have to look up is: Did the file really change? Then, we
    // have to update the file descriptors across all leafs and broadcast an event.
    const openFiles: OpenDocument[] = []
    for (const key in this._windows) {
      const allLeafs = this._windows[key].getAllLeafs()
      for (const leaf of allLeafs) {
        openFiles.push(...leaf.tabMan.openFiles.filter((x) => x.path === filePath))
      }
    }

    const doc = this.documents.find((doc) => doc.filePath === filePath)

    if (doc === undefined) {
      throw new Error(
        `Could not handle remote change for file ${filePath}: Could not find corresponding file!`,
      )
    }

    const metadata = await this._app.fsal.getFilesystemMetadata(filePath)
    const modtime = metadata.modtime
    const ourModtime = doc.descriptor.modtime

    // In response to issue #1621: We will not check for equal modtime but only
    // for newer modtime to prevent sluggish cloud synchronization services
    // (e.g. OneDrive and Box) from having text appear to "jump" from time to time.
    if (modtime <= ourModtime) {
      return // Nothing to do
    }

    // ... however, some cloud services may still emit additional change events
    // that merely change attributes, but not the content. We handle this case
    // next
    const diskContents = await this._app.fsal.loadAnySupportedFile(doc.descriptor.path)

    if (diskContents === doc.lastSavedContent) {
      return
    }

    // Spec section 10: if there is an active review for this document,
    // invalidate it before proceeding with external-change resolution.
    // The review rejects further proposals; both the live editor content
    // and external disk content are preserved; the existing external-change
    // resolution dialog proceeds as normal.
    const _docId = this.getDocumentId(filePath)
    if (_docId !== undefined) {
      await this._reviewApplication.invalidateOnDiskDrift(_docId)
    }

    const isModified = doc.lastSavedVersion !== doc.currentVersion
    const { alwaysReloadFiles } = this._app.config.get()
    if (isModified || !alwaysReloadFiles) {
      // The file is modified in buffer, or the user does not want to simply
      // reload changes, so we cannot just overwrite anything
      // Prevent multiple instances of the dialog, just ask once. The logic
      // always retrieves the most recent version either way
      if (this._remoteChangeDialogShownFor.includes(filePath)) {
        return
      }

      this._remoteChangeDialogShownFor.push(filePath)
      const filename = doc.descriptor.name

      // Ask the user if we should replace the file
      const response = await dialog.showMessageBox({
        title: trans('File changed on disk'),
        message: trans('%s changed on disk', filename),
        detail: isModified
          ? trans(
              '%s has changed on disk, but the editor contains unsaved changes. Do you want to keep the current editor contents or load the file from disk?',
              filename,
            )
          : trans('Do you want to keep the current editor contents or load the file from disk?'),
        type: 'question',
        buttons: [
          trans('Keep editor contents'),
          trans('Load changes from disk')
        ],
        defaultId: 0,
        checkboxLabel: trans(
          'Always load changes from disk if there are no unsaved changes in the editor',
        ),
        checkboxChecked: alwaysReloadFiles,
      })

      this._remoteChangeDialogShownFor.splice(
        this._remoteChangeDialogShownFor.indexOf(filePath),
        1,
      )

      this._app.config.set('alwaysReloadFiles', response.checkboxChecked)

      if (response.response === 0) {
        // User does not want to load the disk contents. To ensure that the
        // proper status is indicated, set the "lastSavedVersion" to one minus.
        doc.lastSavedVersion--
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
          filePath,
          status: 'modification',
        })
      } else {
        await this.notifyRemoteChange(filePath)
      }
    } else {
      // The user has activated the setting to alwaysReloadFiles.
      await this.notifyRemoteChange(filePath)
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
  public async hasMovedFile (oldPath: string, newPath: string): Promise<void> {
    // Basically we just have to close the oldPath, and "open" the new path.
    const openDoc = this.documents.find((doc) => doc.filePath === oldPath)
    if (openDoc === undefined) {
      return // Nothing to do
    }

    // The collaboration sidecar is keyed by the OLD path's hash; carry it to
    // the new path before anything else touches openDoc.filePath, so a crash
    // between the two never leaves the sidecar unreachable under either name.
    await this._reviewApplication.renameCollaboration(openDoc.documentId, oldPath, newPath)

    openDoc.filePath = newPath
    openDoc.descriptor.path = newPath
    openDoc.descriptor.dir = path.dirname(newPath)
    openDoc.descriptor.name = path.basename(newPath)
    openDoc.descriptor.ext = path.extname(newPath)

    // The buffer moved with the document: its live reference overlay moves
    // too (issue #53) — the old path's overlay dies, the new path reports
    // immediately (a move is a single event, not a typing storm).
    this._app.references.dropAuthorityBuffer(oldPath)
    if (openDoc.type === DocumentType.Markdown) {
      this._app.references.reportAuthorityBuffer(newPath, true)
    }

    const leafsToNotify: Array<[string, string]> = []
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      const res = tabMan.replaceFilePath(oldPath, newPath)
      if (res) {
        leafsToNotify.push([ windowId, leafId ])
      }
      return res
    })

    this.syncWatchedFilePaths()

    // Emit the necessary events to each window
    for (const [ windowId, leafId ] of leafsToNotify) {
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
        filePath: oldPath,
        windowId,
        leafId,
      })
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, {
        filePath: newPath,
        windowId,
        leafId,
      })
      // Ensure the renderer picks up the correct (new) active file path, if
      // that has changed (noop in othe cases; see #5574).
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId })
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
  public async hasMovedDir (oldPath: string, newPath: string): Promise<void> {
    // Similar as hasMovedFile, but triggers the command for every affected file
    const docs = this.documents.filter((doc) => doc.filePath.startsWith(oldPath))

    for (const doc of docs) {
      this._app.log.info(
        'Replacing file path for doc ' +
          doc.filePath +
          ' with ' +
          doc.filePath.replace(oldPath, newPath),
      )
      await this.hasMovedFile(doc.filePath, doc.filePath.replace(oldPath, newPath))
    }
  }

  /**
   * This function ensures that our watcher keeps watching the correct files
   */
  private syncWatchedFilePaths (): void {
    // First, get the files currently watched
    const watchedFiles: string[] = []
    const watched = this._watcher.getWatched()
    for (const dir in watched) {
      for (const filename of watched[dir]) {
        watchedFiles.push(path.join(dir, filename))
      }
    }

    // Second, get all open files. NOTE: This does not mean "open open", but
    // rather paths that are "open" somewhere in a leaf. Not actively viewed.
    let openFiles: string[] = []
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        openFiles.push(...leaf.tabMan.openFiles.map((f) => f.path))
      }
    }

    openFiles = [...new Set(openFiles)] // Remove duplicates

    // Third, remove those watched files which are no longer open
    for (const watchedFile of watchedFiles) {
      if (!openFiles.includes(watchedFile)) {
        this._watcher.unwatchPath(watchedFile)
      }
    }

    // Fourth, add those open files not yet watched
    for (const openFile of openFiles) {
      if (!watchedFiles.includes(openFile)) {
        this._watcher.watchPath(openFile)
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
        const stateHasChanged = await callback(leaf.tabMan, windowId, leaf.id)
        if (stateHasChanged) {
          this.syncToConfig()
        }
      }
    }
  }

  /**
   * This method synchronizes the state of the loadedDocuments array into the
   * configuration. It also makes sure to announce changes to whomever it may
   * concern.
   */
  private syncToConfig (): void {
    const toSave: DocumentWindowsJSON = {}
    for (const key in this._windows) {
      toSave[key] = this._windows[key].toJSON()
    }
    this._config.set(toSave)
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
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.setPinnedStatus(filePath, shouldBePinned)
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      windowId,
      leafId,
      filePath,
      status: 'pinned',
    })
    this.syncToConfig()
  }

  /**
   * Broadcasts a remote changed event across the app to notify everyone that a
   * file has been remotely changed.
   *
   * @param {string} filePath The file in question
   */
  public async notifyRemoteChange (filePath: string): Promise<void> {
    // Here we basically only need to close the document and wait for the
    // renderers to reload themselves with getDocument, which will automatically
    // open the new document.
    // Detach before the splice: the sidecar export reads the working text
    // through the live document. (After external drift the review arrives
    // here invalidated, and detaching an invalidated review deletes its
    // sidecar — reloading from disk remains the terminal resolution.)
    const _id = this.getDocumentId(filePath)
    if (_id !== undefined) {
      try {
        await this._detachCollaboration(_id)
      } catch (err) {
        // The reload is what would discard the in-memory review, so it does
        // not happen: the buffer and the review stay, and the renderer is
        // told why the file it saw change was not reloaded.
        this._announceDetachFailure(filePath, err)
        return
      }
    }
    const idx = this.documents.findIndex((file) => file.filePath === filePath)
    this.documents.splice(idx, 1)
    // The reloading renderers re-trigger getDocument, which reports the
    // fresh buffer; until then the saved FSAL snapshot is the truth.
    this._app.references.dropAuthorityBuffer(filePath)
    // Indicate to all affected editors that they should reload the file
    this.broadcastEvent(DP_EVENTS.FILE_REMOTELY_CHANGED, { filePath })
  }

  public sortOpenFiles (windowId: string, leafId: string, newOrder: string[]): void {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    const res = leaf.tabMan.sortOpenFiles(newOrder)
    if (res) {
      this.broadcastEvent(DP_EVENTS.FILES_SORTED, { windowId, leafId })
      this.syncToConfig()
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
  public async moveFile (
    originWindow: string,
    targetWindow: string,
    originLeaf: string,
    targetLeaf: string,
    filePath: string,
  ): Promise<void> {
    // The user has requested to move a file. This basically just means closing
    // the file in the origin, and opening it in the target
    const origin = this._windows[originWindow].findLeaf(originLeaf)
    const target = this._windows[targetWindow].findLeaf(targetLeaf)

    if (origin === undefined || target === undefined) {
      this._app.log.error(
        `[Document Manager] Received a move request from ${originLeaf} to ${targetLeaf} but one of those was undefined.`,
      )
      return
    }

    // First open the file in the target
    let success = target.tabMan.openFile(filePath)
    if (success) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, {
        windowId: targetWindow,
        leafId: targetLeaf,
        filePath,
      })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId: targetWindow,
        leafId: targetLeaf,
      })
      this.syncToConfig()
    }

    // Then decide if we should close the leaf ...
    if (origin.tabMan.openFiles.length === 1) {
      // Close the leaf instead
      this.closeLeaf(originWindow, originLeaf)
      this.syncToConfig()
    } else {
      // ... or rather just close the file
      success = origin.tabMan.closeFile(filePath)
      if (!success) {
        this._app.log.error(
          `[Document Manager] Could not fulfill move request for file ${filePath}: Could not close it.`,
        )
        return
      }

      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, {
        windowId: originWindow,
        leafId: originLeaf,
        filePath,
      })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
        windowId: originWindow,
        leafId: originLeaf,
      })
      this.syncToConfig()
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
  public async splitLeaf (
    originWindow: string,
    originLeaf: string,
    splitDirection: 'horizontal'|'vertical',
    insertion: 'before'|'after' = 'after',
    filePath?: string,
    fromWindow?: string,
    fromLeaf?: string,
  ): Promise<void> {
    // The user has requested a split and following move of a file
    const origin = this._windows[originWindow].findLeaf(originLeaf)

    if (origin === undefined) {
      this._app.log.error(
        `[Document Manager] Received a split request from ${originLeaf} but could not find it.`,
      )
      return
    }

    const target = origin.split(splitDirection, insertion)
    this.broadcastEvent(DP_EVENTS.NEW_LEAF, {
      windowId: originWindow,
      originLeaf,
      newLeaf: target.id,
      direction: splitDirection,
      insertion,
    })

    this.syncToConfig()

    if (filePath !== undefined) {
      const win = fromWindow ?? originWindow
      const leaf = fromLeaf ?? originLeaf
      await this.moveFile(win, originWindow, leaf, target.id, filePath)
    }
  }

  public closeLeaf (windowId: string, leafId: string): void {
    const leaf = this._windows[windowId].findLeaf(leafId)

    if (leaf !== undefined) {
      leaf.parent.removeNode(leaf)
      this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId })
      this._updateFocusLeaf(windowId, this._windows[windowId].getAllLeafs()[0].id)
    }
  }

  /**
   * Returns the hash of the currently active file.
   * @returns {number|null} The hash of the active file.
   */
  public getActiveFile (leafId: string): string|null {
    for (const windowId in this._windows) {
      const leaf = this._windows[windowId].findLeaf(leafId)
      if (leaf !== undefined) {
        return leaf.tabMan.activeFile?.path ?? null
      }
    }
    return null
  }

  public isModified (filePath: string): boolean {
    const doc = this.documents.find((doc) => doc.filePath === filePath)
    if (doc !== undefined) {
      return doc.currentVersion !== doc.lastSavedVersion
    } else {
      return false // None existing files aren't modified
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
      return true
          }
    const scope =
      windowId === undefined ? this.documents : this._windowExclusiveDocuments(windowId)
    return scope.every((doc) => !this.isModified(doc.filePath))
    }

  /**
   * The loaded documents open in a window's panes: the exact set that window's
   * close prompt speaks for. Callers act on this set — save it, throw it away —
   * so an id no window answers to throws by name rather than quietly resolving
   * to 'no documents', which would swallow the user's answer whole.
   */
  private _windowDocuments(windowId: string): Document[] {
    const tree = this._windows[windowId]
    if (tree === undefined) {
      throw new Error(
        `[DocumentManager] Cannot enumerate the documents of unknown window ${windowId}`,
      )
    }
    const openPaths = new Set(
      tree.getAllLeafs().flatMap((leaf) => leaf.tabMan.openFiles.map((file) => file.path)),
    )
    return this.documents.filter((doc) => openPaths.has(doc.filePath))
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
    )
    return this._windowDocuments(windowId).filter(
      (document) => !otherWindowPaths.has(document.filePath),
    )
  }

  public async navigateForward(
    windowId: string,
    leafId: string,
    location?: DocumentLocation,
  ): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    this._stampCurrentHistoryLocation(leaf.tabMan, location)
    const entry = leaf.tabMan.forward()
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: entry?.path,
      location: entry?.location,
    })
  }

  public async navigateBack(
    windowId: string,
    leafId: string,
    location?: DocumentLocation,
  ): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    this._stampCurrentHistoryLocation(leaf.tabMan, location)
    const entry = leaf.tabMan.back()
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: entry?.path,
      location: entry?.location,
    })
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
      tabMan.updateCurrentHistoryLocation(location)
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
    const leaf = windowId in this._windows ? this._windows[windowId].findLeaf(leafId) : undefined
    if (leaf === undefined) {
      return { canGoBack: false, canGoForward: false }
    }

    return {
      canGoBack: leaf.tabMan.canGoBack,
      canGoForward: leaf.tabMan.canGoForward,
    }
  }

  /**
   * The live working text of an open document, normalized. Every review read
   * and every transition takes this explicitly: the document authority owns
   * the text, and a review that outlives its document is a lifecycle bug the
   * caller must not paper over with an empty string.
   */
  private _workingTextOf(documentId: string): string | undefined {
    const filePath = this.getDocumentPath(documentId)
    if (filePath === undefined) {
      return undefined
    }
    const doc = this.documents.find((d) => d.filePath === filePath)
    return doc === undefined ? undefined : normalizeText(doc.document.toString())
  }

  /**
   * Announce one committed review fact. The payload's `generation` is the
   * wire's `reviewGeneration`; anything the emitter left implicit is filled
   * from the committed review, so a caller never has to restate the state it
   * just committed.
   */
  public emitAgentEvent(event: AgentEventType, payload: AgentEventPayload): void {
    const { generation, ...mapped } = payload
    if (generation !== undefined) {
      mapped.reviewGeneration = generation
    }
    const documentId = typeof mapped.documentId === 'string' ? mapped.documentId : undefined
    if (documentId !== undefined) {
      const review = this._reviewApplication.getReview(documentId)
      const workingText = this._workingTextOf(documentId)
      if (review !== undefined) {
        if (!('reviewGeneration' in mapped)) {
          mapped.reviewGeneration = review.generation
        }
        if (!('unresolvedChunks' in mapped) && workingText !== undefined) {
          mapped.unresolvedChunks =
            this._reviewApplication.getStatus(documentId)?.unresolvedChunks
        }
      }
    }
    const agentEvent: AgentEvent = {
      ...mapped,
      event,
      timestamp: new Date().toISOString(),
    }
    this.agentEvents.emit(event, agentEvent)
    this.agentEvents.emit('*', agentEvent)
  }

  // ==========================================================================
  // CollaborationDocumentAuthority — what the collaboration application
  // service may ask of the document authority, and nothing more.
  // ==========================================================================

  public resolveDocumentPath(documentId: string): string | undefined {
    return this.getDocumentPath(documentId)
  }

  /** The document's bytes as they currently are on disk. */
  public async readDiskText(documentPath: string): Promise<string> {
    return readFile(documentPath, 'utf8')
  }

  /**
   * The hash of the bytes this document was last saved from, or undefined
   * when it is not open. This is what a first proposal fences against: the
   * user's own unsaved edits are exactly what the baseline hash binds, so
   * only somebody else's write may refuse the submission.
   */
  public readSavedDiskSha256(documentId: string): string | undefined {
    const filePath = this.getDocumentPath(documentId)
    const doc =
      filePath === undefined
        ? undefined
        : this.documents.find((candidate) => candidate.filePath === filePath)
    return doc === undefined ? undefined : sha256Text(normalizeText(doc.lastSavedContent))
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
    const documentPath = this.getDocumentPath(documentId)
    if (documentPath === undefined) {
      throw new Error(`Cannot replace text for missing document ${documentId}`)
    }
    const doc = this.documents.find((d) => d.filePath === documentPath)
    if (doc === undefined) {
      throw new Error(`Cannot replace text for closed document ${documentId}`)
    }
    if (doc.document.toString() === nextText) {
      return { documentId, documentPath, change: undefined }
    }
    const currentText = doc.document.toString()
    let prefix = 0
    const shorter = Math.min(currentText.length, nextText.length)
    while (prefix < shorter && currentText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
      prefix++
    }
    let suffix = 0
    while (
      suffix < shorter - prefix &&
      currentText.charCodeAt(currentText.length - 1 - suffix) ===
        nextText.charCodeAt(nextText.length - 1 - suffix)
    ) {
      suffix++
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
    )
    return {
      documentId,
      documentPath,
      change: {
        changes,
        update: { changes: serializeChangeSet(changes), clientID: 'review-diff-store' },
        nextText: Text.of(nextText.split('\n')),
        nextVersion: doc.currentVersion + 1,
      },
    }
  }

  /** Apply a prepared replacement. Synchronous, and cannot throw. */
  public commitWorkingTextReplacement(prepared: PreparedDocumentMutation): void {
    if (prepared.change === undefined) {
      return
    }
    const doc = this.documents.find((d) => d.filePath === prepared.documentPath)
    if (doc === undefined) {
      return
    }
    doc.document = prepared.change.nextText
    doc.currentVersion = prepared.change.nextVersion
    doc.updates.push(prepared.change.update)
    while (doc.updates.length > MAX_VERSION_HISTORY) {
      doc.updates.shift()
      doc.minimumVersion += 1
    }
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      filePath: prepared.documentPath,
      status: 'modification',
    })

    // A review decision changed the authority text: feed the references
    // provider's live overlay (issue #53).
    if (doc.type === DocumentType.Markdown) {
      this._app.references.reportAuthorityBuffer(prepared.documentPath)
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
    const filePath = this.getDocumentPath(documentId)
    if (filePath === undefined) {
      return
    }
    const session = this._collaborationSessionFor(documentId, filePath)
    if (session === undefined) {
      return
    }
    this.broadcastEvent(DP_EVENTS.DOCUMENT_COLLABORATION, {
      filePath,
      collaborationSession: session,
    })
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
    this.broadcastCollaborationState(documentId)
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
    return this._reviewApplication.decideChunk(
      reviewId,
      chunkId,
      decision,
      precondition,
    )
  }

  public commentReviewChunk(
    reviewId: string,
    chunkId: string,
    text: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<ChunkCommentResponse | ReviewFailure> {
    return this._reviewApplication.commentChunk(reviewId, chunkId, text, precondition)
  }

  public acceptAllReviewChunks(
    reviewId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<AcceptAllChunksResponse | ReviewFailure> {
    return this._reviewApplication.acceptAllChunks(reviewId, precondition)
  }

  public clearReview(
    reviewId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<ClearReviewResponse | ReviewFailure> {
    return this._reviewApplication.clearReview(reviewId, precondition)
  }

  public addReviewComment(
    reviewId: string,
    text: string,
    expectedReviewGeneration: number,
  ): Promise<AddReviewCommentResponse | ReviewFailure> {
    return this._reviewApplication.addReviewComment(
      reviewId,
      text,
      expectedReviewGeneration,
    )
  }

  /**
   * Returns the reason a review blocks saving `filePath`, or undefined when the
   * save may proceed. Presentation is the renderer's job — see SaveRefusal.
   */
  private async checkReviewDiffSaveGate(
    filePath: string,
  ): Promise<SaveRefusal | undefined> {
    const docId = this.getDocumentId(filePath)
    if (docId === undefined) {
      return undefined
    }
    const review = this._reviewApplication.getReview(docId)
    if (review === undefined) {
      return undefined
    }

    // Pending chunks do not block a save: saving persists the document as-is
    // and the review's status alongside it, so a pending review can be closed
    // and revisited later. The only refusal left is external drift.
    const diskContents = await this._app.fsal.loadAnySupportedFile(filePath)
    if (sha256Text(normalizeText(diskContents)) !== review.diskFenceSha256) {
      this._app.log.warning(
        `[DocumentManager] Save gate closed for ${filePath}: the document changed on disk ` +
          'after the review opened; the external edit was preserved.',
      )
      return {
        reason: 'disk-changed',
        message: trans(
          'The document changed on disk after this review opened. The external edit was preserved.',
        ),
      }
    }

    return undefined
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
    )
  }

  private async _saveFileLocked(filePath: string): Promise<SaveFileResult> {
    const doc = this.documents.find((doc) => doc.filePath === filePath)

    if (doc === undefined) {
      this._app.log.error(
        `[Document Provider] Could not save file ${filePath}: Not found in loaded documents!`,
      )
      return { ok: false }
    }

    // If saveFile was called from a timeout, clearTimeout does nothing but the
    // timeout is reset to undefined. However, implementing this check here
    // ensures that we can programmatically call saveFile anywhere else and
    // still have everything work as intended.
    if (doc.saveTimeout !== undefined) {
      clearTimeout(doc.saveTimeout)
      doc.saveTimeout = undefined
    }

    const refusal = await this.checkReviewDiffSaveGate(filePath)
    if (refusal !== undefined) {
      return { ok: false, refusal }
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
    const docLines = [...doc.document.iterLines()]
    const content = docLines.join('\n')
    doc.lastSavedVersion = doc.currentVersion
    doc.lastSavedContent = content

    if (doc.descriptor.type === 'file') {
      // In case of an MD File increase the word or char count
      const locale: string = this._app.config.get().appLang
      const ast = markdownToAST(content)
      const counts = countAll(ast, locale)
      const newWordCount = counts.words
      const newCharCount = counts.chars

      this._app.stats.updateCounts(
        newWordCount - doc.lastSavedWordCount,
        newCharCount - doc.lastSavedCharCount,
      )

      doc.lastSavedWordCount = newWordCount
      doc.lastSavedCharCount = newCharCount
    }

    // 8.6: a surviving review's sidecar records the save it is about to
    // survive BEFORE the document write, naming both hashes. A process that
    // exits between the two writes is then recoverable: reattachment reads
    // the file and can tell which of them landed. The fence itself does not
    // move until the document write returns.
    const documentId = this.getDocumentId(filePath)
    const savedSha256 = sha256Text(content)
    let reviewSave: ReviewSavePreparation | undefined
    try {
      reviewSave =
        documentId === undefined
          ? undefined
          : await this._reviewApplication.prepareSave(documentId, savedSha256)
    } catch (err) {
      // Nothing is written to disk: an unrecorded save is what makes the
      // crash window unrecoverable, so the save does not start.
      return { ok: false, refusal: this._persistenceRefusal(filePath, err) }
    }

    this._ignoreChanges.push(filePath)

    try {
      if (doc.descriptor.type === 'file') {
        const fileContents = doc.descriptor.bom + content.split('\n').join(doc.descriptor.linefeed)
        await this._app.fsal.writeTextFile(doc.descriptor.path, fileContents)
        doc.descriptor = (await this._app.fsal.getDescriptorFor(
          doc.descriptor.path,
          false,
        )) as MDFileDescriptor
        await this.synchronizeDatabases() // The file may have gotten a library
      } else {
        await this._app.fsal.writeTextFile(doc.descriptor.path, content)
        doc.descriptor = (await this._app.fsal.getDescriptorFor(
          doc.descriptor.path,
          false,
        )) as CodeFileDescriptor
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        dialog.showErrorBox(
          trans('Could not save file'),
          trans('Could not save file %s: %s', doc.descriptor.name, err.message),
        )
      }

      throw err
    }

    this._app.log.info(`[DocumentManager] File ${filePath} saved.`)
    if (reviewSave !== undefined) {
      try {
        await this._reviewApplication.completeSave(reviewSave, savedSha256)
      } catch (err) {
        // The document IS written; only the fence update was lost. The
        // sidecar still carries pendingSave, so reattachment settles it —
        // but this save did not complete, and must not report that it did.
        return { ok: false, refusal: this._persistenceRefusal(filePath, err) }
      }
    }
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
      filePath,
      status: 'modification',
    })
    this.broadcastEvent(DP_EVENTS.FILE_SAVED, { filePath })

    return { ok: true }
  }

  private _updateFocusLeaf (windowId: string, leafId: string): void {
    this._lastEditor.windowId = windowId
    this._lastEditor.leafId = leafId
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: this.getActiveFile(leafId) ?? undefined,
    })
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
    return this._documentIdByPath.get(filePath)
}

  /** The typed refusal every owner-facing annotation channel gives an unresolved path. */
  private _annotationDocumentNotFound(filePath: string): AnnotationFailure {
    return {
      ok: false,
      code: 'DOCUMENT_NOT_FOUND',
      message: `No open document at ${filePath}.`,
    }
  }

  public ensureDocumentId(filePath: string): string {
    return this._assignDocumentId(filePath)
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
      return
    }
    this._app.log.warning(
      `[DocumentManager] Close aborted: ${filePath} could not be saved` +
        (result.refusal === undefined
          ? ' and reported no reason.'
          : ` (${result.refusal.reason}): ${result.refusal.message}`),
    )
    const payload: SaveRefusedBroadcast = {
      filePath,
      refusal: result.refusal,
    }
    broadcastIpcMessage(SAVE_REFUSED_CHANNEL, payload)
  }

  /**
   * DETACH, not destroy: write the review through to its sidecar, then drop
   * the in-memory state. Closing a reviewed file is free — reopening the
   * file reattaches the review. Must run while the document is still in
   * `documents`: the export needs its working text.
   *
   * An invalidated review is the one exception. Its in-process resolution
   * was always destruction (the disk moved underneath it, and reloading
   * from disk closes it), so detaching would only preserve a review that
   * can never be decided again — it is dropped instead. The same document's
   * annotations are written through regardless: they outlive the review
   * that was answering them.
   *
   * A failed write ABORTS the close. It throws, the review stays in memory,
   * the document stays open, and the sidecar keeps its previous valid state.
   * Catching the error and closing anyway is what turned an unwritable
   * sidecar into a silently destroyed review.
   */
  private async _detachCollaboration(documentId: string): Promise<void> {
    await this._reviewApplication.withDocumentLock(documentId, async () => {
      await this._reviewApplication.detachCollaboration(documentId)
    })
  }

  /**
   * A close aborted because the review could not be written through. The
   * renderer surfaces this the same way it surfaces a refused save: the
   * document is still open, and the reason has to reach the person who asked
   * for the close rather than only the log.
   */
  /** The refusal a save owes when the review could not be persisted. */
  private _persistenceRefusal(filePath: string, err: unknown): SaveRefusal {
    const message =
      'The review could not be written to its sidecar, so the save did not complete: ' +
      (err instanceof Error ? err.message : String(err))
    this._app.log.error(`[DocumentManager] Save refused for ${filePath}: ${message}`, err)
    return { reason: 'review-not-persisted', message }
  }

  private _announceDetachFailure(filePath: string, err: unknown): void {
    const message =
      'The review could not be written to its sidecar, so this document was left open: ' +
      (err instanceof Error ? err.message : String(err))
    this._app.log.error(`[DocumentManager] Close aborted for ${filePath}: ${message}`, err)
    const payload: SaveRefusedBroadcast = {
      filePath,
      refusal: { reason: 'review-not-persisted', message },
    }
    broadcastIpcMessage(SAVE_REFUSED_CHANNEL, payload)
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
   * throws, and the close it was called from aborts.
   */
  private async _discardChanges(doc: Document): Promise<void> {
    await this._reviewApplication.withDocumentLock(doc.documentId, async () => {
      await this._discardChangesLocked(doc)
    })
  }

  private async _discardChangesLocked(doc: Document): Promise<void> {
    if (doc.currentVersion === doc.lastSavedVersion) {
      // Nothing was thrown away here, so nothing may be destroyed here: a
      // saved document's review is not the user's to lose at another
      // document's prompt.
      return
    }
    const diskContents = await this._app.fsal.loadAnySupportedFile(doc.filePath)
    await this._reviewApplication.discardCollaboration(
      doc.documentId,
      doc.filePath,
      diskContents,
    )
    this._applyWorkingTextToDocument(doc.filePath, diskContents)
    doc.lastSavedContent = diskContents
    doc.lastSavedVersion = doc.currentVersion
  }

  /**
   * A sidecar failure is never swallowed: it lands in the log for the
   * operator and on the store's event bus for the API (SSE), because the
   * mutation that triggered it already answered its caller.
   */
  private _surfaceReviewSidecarError(documentId: string, action: string, err: unknown): void {
    const message =
      `Review sidecar ${action} failed for document ${documentId}: ` +
      (err instanceof Error ? err.message : String(err))
    this._app.log.error(`[DocumentManager] ${message}`, err)
    this.emitAgentEvent('review.sidecar-error', { documentId, message })
  }

  /**
   * Reattachment — the second half of detach, run when a document loads.
   * Find the sidecar by canonical path, settle any interrupted save, verify
   * the disk fence, then restore the buffer to the working text and the
   * review to its reference. A fence mismatch is external drift observed
   * across a gap in time instead of within a process, and gets the same
   * terminal treatment drift-then-reload gets in-process: the review is
   * announced invalidated and destroyed, and the file opens with the disk
   * content preserved. The document's annotations survive that; their
   * anchors become `orphaned` and wait for the owner to reattach them.
   */
  private async _reattachCollaborationSidecar(doc: Document): Promise<void> {
    try {
      const restored = await this._reviewApplication.reattachCollaboration(
        doc.documentId,
        doc.filePath,
        doc.lastSavedContent,
      )
      // Annotations restore silently: only a restored review gives the
      // sidecar's working text a claim on the buffer.
      if (restored?.workingText === undefined) {
        return
      }
      this._applyWorkingTextToDocument(doc.filePath, restored.workingText)
    } catch (err) {
      // The document itself is fine — open it; the broken sidecar stays on
      // disk as evidence and keeps failing loudly until it is dealt with.
      this._surfaceReviewSidecarError(doc.documentId, 'read', err)
    }
  }

  /**
   * Get the file path for a documentId.
   */
  public getDocumentPath(documentId: string): string | undefined {
    for (const [filePath, id] of this._documentIdByPath) {
      if (id === documentId) {
        return filePath
      }
    }
    return undefined
  }

  public isDocumentOpen(documentPath: string): boolean {
    return this.documents.some(
      (document) => path.resolve(document.filePath) === path.resolve(documentPath),
    )
  }

  public readSupportedFile(filePath: string): Promise<string> {
    return this._app.fsal.loadAnySupportedFile(filePath)
  }

  /**
   * Assign a documentId for a newly loaded document.
   * Called internally during document loading.
   */
  private _assignDocumentId(filePath: string): string {
    const existing = this._documentIdByPath.get(filePath)
    if (existing !== undefined) {
      return existing
    }
    const id = `doc-${randomUUID()}`
    this._documentIdByPath.set(filePath, id)
    return id
  }

  /**
   * Resolve the currently focused view.
   * Returns the viewId, windowId, leafId, and documentId of the active pane.
   */
  public getFocusedView():
    | {
        viewId: string
        windowId: string
        leafId: string
        documentId: string | undefined
      }
    | undefined {
    if (this._lastEditor.windowId === undefined || this._lastEditor.leafId === undefined) {
      return undefined
    }
    const activePath = this.getActiveFile(this._lastEditor.leafId)
    if (activePath === null) {
      return undefined
    }
    return {
      viewId: `view-${this._lastEditor.windowId}-${this._lastEditor.leafId}`,
      windowId: this._lastEditor.windowId,
      leafId: this._lastEditor.leafId,
      documentId: this.getDocumentId(activePath),
    }
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
        content: string
        sha256: string
        lineCount: number
        truncated: boolean
      }
    | undefined {
    const filePath = this.getDocumentPath(documentId)
    if (filePath === undefined) {
      return undefined
    }
    const doc = this.documents.find((d) => d.filePath === filePath)
    if (doc === undefined) {
      return undefined
    }
    const fullContent = doc.document.toString()
    const lines = fullContent.split('\n')
    const totalLines = lines.length
    let content = fullContent
    let truncated = false
    if (startLine !== undefined && endLine !== undefined) {
      // CLI line ranges are one-based and inclusive
      const start = Math.max(0, startLine - 1)
      const end = Math.min(totalLines, endLine)
      content = lines.slice(start, end).join('\n')
      truncated = end < totalLines
    }
    return {
      content,
      sha256: sha256Text(fullContent),
      lineCount: totalLines,
      truncated,
    }
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
  ): Promise<SubmittedProposal | { ok: false; code: string; message: string }> {
    return this._reviewApplication.submitProposal({
      documentId,
      baselineSha256,
      claims,
      clientRequestId,
      expectedReviewGeneration,
    })
  }

  public async retractProposal(
    packetId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<
    | RetractProposalResponse
    | {
        ok: false
        code: AgentErrorCode
        message: string
        reviewId: string
        canClearUnresolved: boolean
        actual?: { sha256: string }
        reviewGeneration?: number
      }
  > {
    const result = await this._reviewApplication.retractProposal(packetId, precondition)
    if ('ok' in result && !result.ok && result.code === 'PACKET_NOT_RETRACTABLE' && result.reviewId === '') {
      // GET /v1/reviews/{id}/packets hands out a detached review's packetIds,
      // so this route owes them an answer. The live store dropped them when
      // the file closed; the sidecar still carries them, and the refusal it
      // earns is the same one every reviewId route gives — the file is shut,
      // not the packet missing. Clearing is shut too, so say so.
      const detached = (await this._reviewApplication.listReviewQueries()).find(
        (query) =>
          !query.attached &&
          query.sidecar.review.packets.some((packet) => packet.packetId === packetId),
      )
      if (detached !== undefined && !detached.attached) {
        return {
          ok: false,
          code: 'DOCUMENT_CLOSED',
          message:
            `The reviewed document ${detached.sidecar.documentPath} is not open. ` +
            'Open it to reattach this review, then retract this packet.',
          reviewId: detached.sidecar.review.reviewId,
          canClearUnresolved: false,
        }
      }
    }
    return result
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
    })
  }

  /**
   * One more turn of an annotation thread. The only annotation mutation the
   * agent HTTP API exposes — every other move routes through `actor` and is
   * refused by the pure transition (I3).
   */
  public async addAnnotationMessage(
    documentId: string,
    annotationId: string,
    actor: AnnotationActor,
    text: string,
    clientRequestId: string | undefined,
    expectedAnnotationGeneration: number,
  ): Promise<AnnotationMessage | AnnotationFailure> {
    return this._reviewApplication.addAnnotationMessage({
      documentId,
      annotationId,
      actor,
      text,
      clientRequestId,
      expectedAnnotationGeneration,
    })
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
    })
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
    })
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
    })
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
    })
  }

  /**
   * Get the review store for direct agent API method dispatch.
   */
  public get reviewStore(): CollaborationApplicationService['reviewStore'] {
    return this._reviewApplication.reviewStore
  }

  /** Read-only review projections for transport providers. */
  public get reviewQueries(): ReviewQueryPort {
    return this._reviewApplication
  }

  /** Read-only annotation projections for transport providers. */
  public get annotationQueries(): Pick<CollaborationApplicationService, 'getAnnotations'> {
    return this._reviewApplication
  }

  /**
   * The live working text of an open document, normalized — the text every
   * review read projection must be given. Undefined when the document is not
   * open, which is the caller's signal that only the sidecar can answer.
   */
  public readWorkingText(documentId: string): string | undefined {
    return this._workingTextOf(documentId)
  }

  /**
   * The status of a document's active review, against its live text. The one
   * place the working text is paired with the review for a status read, so
   * no caller can project a review against a text it does not have.
   */
  public reviewStatus(documentId: string): ReviewStatus | undefined {
    return this._reviewApplication.getStatus(documentId)
  }

  /**
   * Expose the loaded documents array for the agent API provider to enumerate
   * open documents.
   */
  public get loadedDocuments(): readonly Document[] {
    return this.documents
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
    const doc = this.documents.find((d) => d.filePath === filePath)
    if (doc === undefined || doc.type !== DocumentType.Markdown) {
      return undefined
    }
    return doc.document.toString()
  }

  /**
   * Apply a workspace edit to every open Markdown document named by the
   * transaction set. The document manager is the central collab authority:
   * it prepares every ChangeSet before mutating any document, records one
   * serialized authority update per touched document, then broadcasts the
   * updates for every renderer pane to pull.
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
    const editsByDocument = new Map<string, WorkspaceTextEdit[]>()
    for (const edit of edits) {
      const documentEdits = editsByDocument.get(edit.documentPath)
      if (documentEdits === undefined) {
        editsByDocument.set(edit.documentPath, [edit])
      } else {
        documentEdits.push(edit)
      }
    }

    const prepared: Array<{
      document: Document
      filePath: string
      nextText: Text
      update: SerializedUpdate
    }> = []
    for (const [filePath, documentEdits] of editsByDocument) {
      const document = this.documents.find((candidate) => candidate.filePath === filePath)
      assert(document !== undefined, `[DocumentManager] Workspace edit names unopened document ${filePath}`)
      assert(
        document.type === DocumentType.Markdown,
        `[DocumentManager] Workspace edit names non-Markdown document ${filePath}`,
      )
      const changes = ChangeSet.of(
        documentEdits.map((edit) => ({
          from: edit.range.from,
          to: edit.range.to,
          insert: edit.insert,
        })),
        document.document.length,
      )
      const update = {
        changes: serializeChangeSet(changes),
        clientID: 'reference-rename',
      }
      prepared.push({
        document,
        filePath,
        nextText: changes.apply(document.document),
        update,
      })
    }

    for (const transaction of prepared) {
      transaction.document.document = transaction.nextText
      transaction.document.currentVersion += 1
      transaction.document.updates.push(transaction.update)
      while (transaction.document.updates.length > MAX_VERSION_HISTORY) {
        transaction.document.updates.shift()
        transaction.document.minimumVersion += 1
      }
    }

    for (const transaction of prepared) {
      this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, {
        filePath: transaction.filePath,
        status: 'modification',
      })
      this._app.references.reportAuthorityBuffer(transaction.filePath)
    }

    return prepared.map((transaction) => transaction.filePath)
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
    const document = this.documents.find((candidate) => candidate.filePath === filePath)
    if (document === undefined) {
      return undefined
    }
    return collaborationSessionFor({
      documentId,
      documentPath: filePath,
      workingText: document.document.toString(),
      review: this._reviewApplication.getReview(documentId),
      annotations: this._reviewApplication.getAnnotations(documentId),
    })
  }

  /**
   * Replace the live document text through the authority's own prepare/commit
   * pair. Used by the lifecycle paths that own their own persistence —
   * discard and reattach — where the text is not a review decision's output.
   */
  private _applyWorkingTextToDocument(filePath: string, workingText: string): void {
    const documentId = this.getDocumentId(filePath)
    if (documentId === undefined) {
      return
    }
    this.commitWorkingTextReplacement(
      this.prepareWorkingTextReplacement(documentId, workingText),
    )
  }
}
