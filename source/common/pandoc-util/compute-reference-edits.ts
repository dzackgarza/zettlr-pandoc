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

import {
  type DocumentReferenceSnapshot,
  type ReferenceFamily,
  referenceFamilyOf,
  type WorkspaceReferenceEdit,
  type WorkspaceTextEdit,
} from "../../types/common/references";

/**
 * A typed reason for refusing to compute a rename. Rejections are values,
 * never exceptions: every caller (ipc surface, dialog, command) branches on
 * `kind` to present the refusal.
 */
export type ReferenceRenameRejection =
  | { kind: "malformed-key"; newKey: string }
  | { kind: "family-changed"; oldFamily: ReferenceFamily; newFamily: ReferenceFamily }
  | { kind: "collision"; newKey: string; definitionPaths: string[] }
  | { kind: "unknown-key"; oldKey: string };

/**
 * The outcome of a rename preview: either the complete previewed
 * WorkspaceReferenceEdit or a typed rejection.
 */
export type ReferenceRenamePreview =
  | { status: "ok"; edit: WorkspaceReferenceEdit }
  | { status: "rejected"; reason: ReferenceRenameRejection };

/**
 * The wire outcome of ReferenceProvider's 'commit-rename' command.
 *
 * BOUNDARY SPLIT: the provider can only write CLOSED files itself (atomic
 * temp+rename in the file's own directory). Open buffers are applied by the
 * central document authority, which records collab updates for every renderer
 * pane and acknowledges every touched path before success is returned. A
 * conflict outcome means NOTHING was applied anywhere.
 */
export type CommitRenameOutcome =
  | {
      status: "applied";
      /** Closed documents atomically rewritten on disk by the provider */
      closedFilesWritten: string[];
      /** Open documents whose authority updates were acknowledged */
      openBuffersUpdated: string[];
    }
  | {
      status: "conflict";
      conflict: {
        status: "conflict";
        documentPath: string;
        expectedSourceHash: string;
        actualSourceHash: string;
      };
    };

/**
 * The wire outcome of ReferenceProvider's 'undo-rename' command. The undo
 * record is one-shot: a successful undo consumes it ('no-pending-undo'
 * afterwards); a conflicted undo leaves it pending. The same
 * open-buffer/closed-file boundary split as CommitRenameOutcome applies.
 */
export type UndoRenameOutcome =
  | {
      status: "applied";
      closedFilesWritten: string[];
      openBuffersUpdated: string[];
    }
  | {
      status: "conflict";
      conflict: {
        status: "conflict";
        documentPath: string;
        expectedSourceHash: string;
        actualSourceHash: string;
      };
    }
  | { status: "no-pending-undo" };

/**
 * Characters that would terminate the authored token if they appeared inside
 * a replacement key: whitespace plus the cluster/attribute delimiters.
 */
const TOKEN_TERMINATORS = /[\s}\];,@]/;

/**
 * Computes the previewed workspace rename of `oldKey` to `newKey` over the
 * merged snapshots, per the module contract above.
 *
 * VALIDATION ORDER (each rejection must stay independently reachable — the
 * discrimination specs fail on any blanket rejection):
 *
 * 1. `malformed-key`: `newKey` is structurally not a supported reference key
 *    (no supported `family:slug` shape, or the slug contains a character
 *    that would terminate the authored token). Checked first so a malformed
 *    replacement is never laundered into a family or collision rejection.
 * 2. `family-changed`: both keys parse to supported families and they
 *    differ. Checked before collision/unknown so a known key with a
 *    family-crossing replacement reports the actual violation.
 * 3. `collision`: `newKey` already has at least one definition anywhere
 *    (including `newKey === oldKey`), naming every colliding definition.
 * 4. `unknown-key`: `oldKey` has no definition in the given snapshots.
 *    Checked last: it must only fire when nothing more specific applies.
 *
 * @param   {DocumentReferenceSnapshot[]}  snapshots  The merged workspace snapshots
 * @param   {string}                       oldKey     The full key being renamed
 * @param   {string}                       newKey     The full replacement key
 *
 * @return  {ReferenceRenamePreview}                  The previewed edit or a typed rejection
 */
export function previewReferenceRename(
  snapshots: DocumentReferenceSnapshot[],
  oldKey: string,
  newKey: string,
): ReferenceRenamePreview {
  // 1. Structural validation of the replacement key
  const newFamily = referenceFamilyOf(newKey);
  if (newFamily === undefined || TOKEN_TERMINATORS.test(newKey)) {
    return { status: "rejected", reason: { kind: "malformed-key", newKey } };
  }

  // 2. Prefix preservation: renames never move a key across families. An
  // oldKey without a supported family cannot be defined anywhere, so it
  // falls through to the unknown-key rejection below.
  const oldFamily = referenceFamilyOf(oldKey);
  if (oldFamily !== undefined && newFamily !== oldFamily) {
    return { status: "rejected", reason: { kind: "family-changed", oldFamily, newFamily } };
  }

  // 3. Collision: the replacement key must be defined nowhere (a self-rename
  // collides with itself, never a silent no-op).
  const collidingPaths = snapshots
    .filter((snapshot) => snapshot.definitions.some((definition) => definition.key === newKey))
    .map((snapshot) => snapshot.documentPath);
  if (collidingPaths.length > 0) {
    return {
      status: "rejected",
      reason: { kind: "collision", newKey, definitionPaths: collidingPaths },
    };
  }

  // 4. The old key must actually be defined somewhere in the workspace.
  const isDefined = snapshots.some((snapshot) =>
    snapshot.definitions.some((definition) => definition.key === oldKey),
  );
  if (!isDefined) {
    return { status: "rejected", reason: { kind: "unknown-key", oldKey } };
  }

  // Edit computation: EVERY definition and EVERY occurrence of oldKey across
  // every document (pinned duplicate-rename semantics), grouped per document
  // in document order, ordered by range within each document.
  const edits: WorkspaceTextEdit[] = [];
  const undo: WorkspaceTextEdit[] = [];
  const expectedSourceHashes: Record<string, string> = {};

  for (const snapshot of snapshots) {
    // The forward token replacements of this document, tagged with the
    // inverse token so the undo edit restores the exact authored bytes.
    const documentEdits: Array<{ edit: WorkspaceTextEdit; inverseInsert: string }> = [];

    for (const definition of snapshot.definitions) {
      if (definition.key === oldKey) {
        documentEdits.push({
          edit: {
            documentPath: snapshot.documentPath,
            range: { ...definition.range },
            insert: "#" + newKey,
          },
          inverseInsert: "#" + oldKey,
        });
      }
    }

    for (const occurrence of snapshot.occurrences) {
      if (occurrence.key === oldKey) {
        documentEdits.push({
          edit: {
            documentPath: snapshot.documentPath,
            range: { ...occurrence.range },
            insert: "@" + newKey,
          },
          inverseInsert: "@" + oldKey,
        });
      }
    }

    if (documentEdits.length === 0) {
      continue;
    }

    documentEdits.sort((a, b) => a.edit.range.from - b.edit.range.from);
    expectedSourceHashes[snapshot.documentPath] = snapshot.sourceHash;

    // The inverse edits are expressed in POST-edit coordinates: walk the
    // ascending forward edits, tracking the cumulative length delta of the
    // preceding replacements.
    let delta = 0;
    for (const { edit, inverseInsert } of documentEdits) {
      edits.push(edit);
      const from = edit.range.from + delta;
      undo.push({
        documentPath: edit.documentPath,
        range: { from, to: from + edit.insert.length },
        insert: inverseInsert,
      });
      delta += edit.insert.length - (edit.range.to - edit.range.from);
    }
  }

  return {
    status: "ok",
    edit: {
      edits,
      expectedSourceHashes,
      openBufferPaths: [],
      closedFilePaths: [],
      conflict: { status: "clean" },
      undo,
    },
  };
}

/**
 * One affected document of a previewed rename, as the rename preview UI
 * presents it (issue #1, review A4 / US-17): the document, its exact edit
 * count, and the authored context snippet of every affected range in
 * document order.
 */
export interface RenamePreviewFileSummary {
  documentPath: string;
  /** The number of previewed text edits in this document */
  editCount: number;
  /** One authored context snippet per affected range, in document order */
  snippets: string[];
}

/**
 * Builds the per-file summary the rename preview dialog renders, from a
 * previewed WorkspaceReferenceEdit and the workspace snapshots it was
 * computed over. Documents appear in the edit's own document order; each
 * affected range contributes its authored context — the definition's
 * preview-source head line for definition tokens, the authored citation
 * cluster for occurrence tokens.
 *
 * @param   {WorkspaceReferenceEdit}       edit       The previewed edit
 * @param   {DocumentReferenceSnapshot[]}  snapshots  The snapshots previewed over
 * @param   {string}                       oldKey     The key being renamed
 *
 * @return  {RenamePreviewFileSummary[]}              The per-file summary
 */
export function buildRenamePreviewSummary(
  edit: WorkspaceReferenceEdit,
  snapshots: DocumentReferenceSnapshot[],
  oldKey: string,
): RenamePreviewFileSummary[] {
  const summaries: RenamePreviewFileSummary[] = [];
  const byPath = new Map(snapshots.map((snapshot) => [snapshot.documentPath, snapshot]));

  for (const textEdit of edit.edits) {
    let summary = summaries.find((candidate) => candidate.documentPath === textEdit.documentPath);
    if (summary === undefined) {
      summary = { documentPath: textEdit.documentPath, editCount: 0, snippets: [] };
      summaries.push(summary);
    }
    summary.editCount++;

    const snapshot = byPath.get(textEdit.documentPath);
    if (snapshot === undefined) {
      throw new Error(
        `Rename preview summary: no snapshot for previewed document ${textEdit.documentPath}`,
      );
    }

    // The affected range is either a definition id token or an occurrence
    // key token of oldKey; surface its authored context.
    const definition = snapshot.definitions.find((candidate) => {
      return (
        candidate.key === oldKey &&
        textEdit.range.from >= candidate.range.from &&
        textEdit.range.to <= candidate.range.to
      );
    });
    if (definition !== undefined) {
      summary.snippets.push(definition.previewSource.split("\n", 1)[0]);
      continue;
    }

    const occurrence = snapshot.occurrences.find((candidate) => {
      return (
        candidate.key === oldKey &&
        textEdit.range.from >= candidate.range.from &&
        textEdit.range.to <= candidate.range.to
      );
    });
    if (occurrence === undefined) {
      throw new Error(
        `Rename preview summary: previewed range [${textEdit.range.from},${textEdit.range.to}] in ${textEdit.documentPath} matches no authored ${oldKey} token`,
      );
    }
    summary.snippets.push(occurrence.clusterRaw);
  }

  return summaries;
}
