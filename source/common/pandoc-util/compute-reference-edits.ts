/**
 * Computes previewed workspace reference-rename edits (issue #1, Phase 6).
 *
 * This module is the PURE half of the workspace rename protocol. It runs in
 * both the main process (ReferenceProvider 'preview-rename') and, for
 * previews, potentially the renderer, so it must stay renderer-safe: no Node
 * built-ins, no Electron, no CodeMirror imports, and no filesystem access.
 *
 * CONTRACT (locked red by test/compute-reference-edits.spec.ts):
 *
 * previewReferenceRename(snapshots, oldKey, newKey) computes the complete,
 * exact edit set renaming `oldKey` to `newKey` over the given merged
 * workspace snapshots (live overlays already substituted by the caller — the
 * function neither knows nor cares which documents are open buffers):
 *
 * - VALIDATION (typed rejections, never throws):
 *   - `malformed-key`: `newKey` is structurally not a supported reference
 *     key — no colon, empty slug after the family (`thm:`), an unsupported
 *     family (`table:x`), or a slug containing characters that would
 *     terminate the authored token (whitespace, `}`, `]`, `;`, `,`, `@`).
 *   - `family-changed`: `newKey` parses to a supported family differing from
 *     `oldKey`'s family. Renames are prefix-preserving: `thm:a` -> `lem:b`
 *     is always rejected.
 *   - `collision`: `newKey` already has at least one definition anywhere in
 *     the workspace (including `newKey === oldKey`: renaming a key onto
 *     itself is a collision with itself, never a silent no-op). The
 *     rejection names every colliding definition's documentPath.
 *   - `unknown-key`: `oldKey` has no definition in the given snapshots.
 *
 * - EDITS (on acceptance):
 *   - One edit per definition of `oldKey` replacing the full authored id
 *     token: `range` is exactly the definition's extracted range (spanning
 *     `#oldKey` including the `#` sigil), `insert` is `'#' + newKey`.
 *   - One edit per occurrence of `oldKey` replacing the authored `@` token:
 *     `range` is exactly the occurrence's extracted range (spanning
 *     `@oldKey` including the `@` sigil), `insert` is `'@' + newKey`. This
 *     covers bare occurrences and occurrences inside bracketed clusters;
 *     cluster punctuation, sibling keys, prefixes, suffixes, and locators
 *     are never touched.
 *   - DUPLICATE-RENAME SEMANTICS (pinned reading of the issue #1 contract):
 *     renaming a duplicated key edits ALL of its definitions and ALL of its
 *     occurrences across every document. The typed model mandates that
 *     duplicates "always retain every definition and never select one
 *     silently" — a rename that touched only one duplicate definition would
 *     both silently select one AND silently split the key into a
 *     resolved/missing pair the author never wrote. The whole key is
 *     renamed, preserving its (diagnosed) duplicate state under the new
 *     name.
 *
 * - RESULT SHAPE (on acceptance):
 *   - `edit.edits` contains every edit, grouped per document in document
 *     order.
 *   - `edit.expectedSourceHashes` maps EXACTLY the touched documentPaths to
 *     the sourceHash of the snapshot the edits were computed against.
 *   - `edit.openBufferPaths` and `edit.closedFilePaths` are EMPTY: the pure
 *     preview never partitions documents. Partitioning into open-buffer
 *     transactions vs closed-file disk writes happens at a HIGHER layer
 *     (ReferenceProvider commit, which owns the live-overlay map).
 *   - `edit.conflict` is `{ status: 'clean' }`: conflicts can only be
 *     discovered at commit time against current reality.
 *   - `edit.undo` contains the inverse edits: applying `edits` to the
 *     snapshot sources and then applying `undo` to the results restores
 *     every touched document byte-exactly (undo ranges are expressed in
 *     post-edit coordinates).
 */

import type {
  DocumentReferenceSnapshot,
  ReferenceFamily,
  WorkspaceReferenceEdit,
  WorkspaceTextEdit
} from '../../types/common/references'

/**
 * A typed reason for refusing to compute a rename. Rejections are values,
 * never exceptions: every caller (ipc surface, dialog, command) branches on
 * `kind` to present the refusal.
 */
export type ReferenceRenameRejection =
  | { kind: 'malformed-key', newKey: string }
  | { kind: 'family-changed', oldFamily: ReferenceFamily, newFamily: ReferenceFamily }
  | { kind: 'collision', newKey: string, definitionPaths: string[] }
  | { kind: 'unknown-key', oldKey: string }

/**
 * The outcome of a rename preview: either the complete previewed
 * WorkspaceReferenceEdit or a typed rejection.
 */
export type ReferenceRenamePreview =
  | { status: 'ok', edit: WorkspaceReferenceEdit }
  | { status: 'rejected', reason: ReferenceRenameRejection }

/**
 * The wire outcome of ReferenceProvider's 'commit-rename' command.
 *
 * BOUNDARY SPLIT: the provider can only write CLOSED files itself (atomic
 * temp+rename in the file's own directory). Open buffers belong to the
 * renderer's live CodeMirror instances, which the main process cannot
 * reach — so an applied commit RETURNS the open-buffer edits as
 * `openBufferTransactions` and the RENDERER applies them as CodeMirror
 * transactions (leaving the buffers dirty/unsaved) and re-reports the live
 * snapshot. A conflict outcome means NOTHING was applied anywhere.
 */
export type CommitRenameOutcome =
  | {
    status: 'applied'
    /** Closed documents atomically rewritten on disk by the provider */
    closedFilesWritten: string[]
    /** Open-buffer edits the renderer must apply as CodeMirror transactions */
    openBufferTransactions: WorkspaceTextEdit[]
  }
  | { status: 'conflict', conflict: { status: 'conflict', documentPath: string, expectedSourceHash: string, actualSourceHash: string } }

/**
 * The wire outcome of ReferenceProvider's 'undo-rename' command. The undo
 * record is one-shot: a successful undo consumes it ('no-pending-undo'
 * afterwards); a conflicted undo leaves it pending. The same
 * open-buffer/closed-file boundary split as CommitRenameOutcome applies.
 */
export type UndoRenameOutcome =
  | {
    status: 'applied'
    closedFilesWritten: string[]
    openBufferTransactions: WorkspaceTextEdit[]
  }
  | { status: 'conflict', conflict: { status: 'conflict', documentPath: string, expectedSourceHash: string, actualSourceHash: string } }
  | { status: 'no-pending-undo' }

/**
 * Computes the previewed workspace rename of `oldKey` to `newKey` over the
 * merged snapshots, per the module contract above.
 *
 * PHASE 6 INERT SKELETON: no validation or edit computation exists yet; the
 * function rejects every request as `unknown-key`. Every branch of the real
 * contract is locked red by test/compute-reference-edits.spec.ts, including
 * a discrimination spec that fails on exactly this blanket rejection.
 *
 * @param   {DocumentReferenceSnapshot[]}  _snapshots  The merged workspace snapshots
 * @param   {string}                       oldKey      The full key being renamed
 * @param   {string}                       _newKey     The full replacement key
 *
 * @return  {ReferenceRenamePreview}                   The previewed edit or a typed rejection
 */
export function previewReferenceRename (
  _snapshots: DocumentReferenceSnapshot[],
  oldKey: string,
  _newKey: string
): ReferenceRenamePreview {
  return { status: 'rejected', reason: { kind: 'unknown-key', oldKey } }
}
