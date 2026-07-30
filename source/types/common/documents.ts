import type { TabManagerJSON } from 'source/app/service-providers/documents/document-tree/tab-manager'

/**
 * A descriptor for some metadata that is associated to opened documents, such
 * as pinning status, or an icon.
 */
export interface OpenDocument {
  /**
   * The full path to the document
   */
  path: string
  /**
   * Indicates whether this document should be handled as pinned
   */
  pinned: boolean
  /**
   * An icon that will allow us to save space by associating icons to documents
   * instead of the filenames
   */
  icon?: string
}

/**
 * This enum describes supported file types that can be opened in an editor.
 */
export enum DocumentType {
  Markdown = 1,
  LaTeX,
  YAML,
  JSON,
}

/**
 * A JSON serializable representation of a document tree leaf
 */
export interface LeafNodeJSON extends TabManagerJSON {
  /**
   * Indicates that this is a leaf
   */
  type: 'leaf'
  /**
   * The ID for this leaf (UUID)
   */
  id: string
}

/**
 * A JSON serializable representation of a document tree branch
 */
export interface BranchNodeJSON {
  /**
   * Indicates that this is a branch
   */
  type: 'branch'
  /**
   * The ID for this branch (UUID)
   */
  id: string
  /**
   * The direction into which this branch splits the tree
   */
  direction: 'horizontal'|'vertical'
  /**
   * A list of all child nodes for this branch
   */
  nodes: Array<LeafNodeJSON|BranchNodeJSON>
  /**
   * The sizes (in percent) of the individual child nodes
   */
  sizes: number[]
}

/**
 * This enumeration contains events emitted by the DocumentsProvider across main
 * and renderer processes
 */
export enum DP_EVENTS {
  // Opening/closing of files
  OPEN_FILE = 'file-opened',
  CLOSE_FILE = 'file-closed',
  FILE_REMOTELY_CHANGED = 'file-remotely-changed',
  FILE_REMOTE_CHANGE_ERROR = 'file-remote-change-error',
  FILES_SORTED = 'files-sorted',
  // File status (pinned, modified, ...)
  CHANGE_FILE_STATUS = 'file-status-changed',
  FILE_SAVED = 'file-saved',
  ACTIVE_FILE = 'active-file-changed',
  REVIEW_DIFF = 'review-diff',
  // Leafs (editor panes)
  NEW_LEAF = 'leaf-created',
  LEAF_CLOSED = 'leaf-deleted',
  // Windows
  NEW_WINDOW = 'window-created',
  WINDOW_CLOSED = 'window-deleted'
}

/**
 * A collab update in the form it actually crosses IPC.
 *
 * `changes` is the output of `ChangeSet.toJSON()`, not a `ChangeSet`. Both the
 * provider's update history and the push/pull IPC payloads hold this form: a
 * live `ChangeSet` sent through structured clone arrives as a plain object that
 * `ChangeSet.fromJSON` rejects with "Invalid JSON representation of ChangeSet",
 * which breaks the pull loop and strands the renderer at a stale version.
 *
 * This type exists because `@codemirror/collab`'s `Update.changes` is a
 * `ChangeSet` and `ChangeSet.toJSON()` returns `any`, so annotating the wire as
 * `Update[]` type-checked while being wrong in both directions — and allowed a
 * real `ChangeSet` to be pushed into the history undetected.
 */
/**
 * Why the provider refused to write a file. These live here, not in the
 * documents provider, because they cross IPC in both directions and the
 * renderer must be able to name them: importing a runtime value from the
 * provider module drags i18n-main (and gettext-parser's Node code) into the
 * renderer bundle, which fails the webpack build outright.
 */
export type SaveRefusalReason = 'unresolved-chunks' | 'review-out-of-sync' | 'disk-changed'

export interface SaveRefusal {
  reason: SaveRefusalReason
  message: string
}

/**
 * A save either wrote the file or refused with a reason. Deliberately not a bare
 * boolean: `false` is what let the save gate fail silently at the IPC boundary,
 * leaving the renderer to log "falsy result" with no cause.
 */
export type SaveFileResult =
  | { ok: true }
  | { ok: false, refusal?: SaveRefusal }

/**
 * Broadcast on SAVE_REFUSED_CHANNEL when a save the user did not initiate from
 * the editor is refused — the close-and-save prompts, which run in main and have
 * no renderer promise to hand the result back to. Without this the prompt simply
 * closes and the window stays open with nothing explaining why.
 */
export interface SaveRefusedBroadcast {
  filePath: string
  refusal?: SaveRefusal
}

export const SAVE_REFUSED_CHANNEL = 'save-refused'

/** Opaque `ChangeSet.toJSON()` payload; only `ChangeSet.fromJSON` reads it. */
export type SerializedChanges = readonly (number | readonly (number | string)[])[]

export interface SerializedUpdate {
  changes: SerializedChanges
  clientID: string
}
