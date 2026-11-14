/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace edit proposals
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An edit of several documents that an action of the author
 *                  causes (a move retargets links, a tag rename changes
 *                  tags) is a proposal first: the edits, the hash of each
 *                  text they were made on, and each changed line before and
 *                  after. The window shows it; no file changes until the
 *                  author applies. The apply is the journaled workspace-edit
 *                  transaction, fenced by those hashes, and then a save of
 *                  each open document that it changed.
 *
 * END HEADER
 */

import { hashDocumentSource } from "@common/pandoc-util/extract-references";
import {
  changedDocuments,
  type ProposedDocument,
  previewOf,
} from "@common/util/workspace-edit-preview";
import type { SaveFileResult, UnsavedDocument } from "@dts/common/documents";
import type { WorkspaceTextEdit } from "@dts/common/references";
import type { WorkspaceEditProposal } from "@dts/common/workspace-edit";
import { randomUUID } from "crypto";
import {
  editsBetween,
  runWorkspaceEditTransaction,
  saveUpdatedBuffers,
  type WorkspaceEditAuthority,
} from "../service-providers/references/workspace-edit-transaction";

/** The document authority that an apply edits through: open buffers and their save. */
export interface WorkspaceEditDocuments extends WorkspaceEditAuthority {
  saveFile: (filePath: string) => Promise<SaveFileResult>;
}

/** The input of an apply: the edits and the hash of each text they were made on. */
export interface WorkspaceEditPlan {
  edits: WorkspaceTextEdit[];
  expectedSourceHashes: Record<string, string>;
}

/** The outcome of an apply. A failed write rejects; nothing changed then. */
export type WorkspaceEditOutcome =
  | { status: "conflict"; documentPath: string }
  | { status: "applied"; documentsChanged: string[]; unsaved: UnsavedDocument[] };

/**
 * The proposal of the edit that takes each document from its source to its
 * target. A document whose target is its source is not in it. Answers
 * undefined when no document changes.
 */
export function proposalOf(
  title: string,
  description: string,
  documents: ProposedDocument[],
): WorkspaceEditProposal | undefined {
  const changed = changedDocuments(documents);
  if (changed.length === 0) {
    return undefined;
  }
  return {
    id: randomUUID(),
    title,
    description,
    edits: changed.flatMap(({ documentPath, source, target }) =>
      editsBetween(documentPath, source, target),
    ),
    expectedSourceHashes: Object.fromEntries(
      changed.map(({ documentPath, source }) => [documentPath, hashDocumentSource(source)]),
    ),
    documents: previewOf(changed),
  };
}

/**
 * Applies a planned edit through the journaled workspace-edit transaction:
 * nothing changes when a document changed after the plan was made, and a
 * failed write rolls back each document that changed. Each open document
 * that the edit changed is then saved; a refused save leaves the edit in its
 * buffer and is in `unsaved`.
 */
export async function applyWorkspaceEdit(
  documents: WorkspaceEditDocuments,
  journalDirectory: string,
  plan: WorkspaceEditPlan,
): Promise<WorkspaceEditOutcome> {
  const result = await runWorkspaceEditTransaction(documents, journalDirectory, plan);
  if (result.status === "conflict") {
    return { status: "conflict", documentPath: result.documentPath };
  }
  const unsaved = await saveUpdatedBuffers(
    async (documentPath) => await documents.saveFile(documentPath),
    result.openBuffersUpdated,
  );
  return {
    status: "applied",
    documentsChanged: [...result.openBuffersUpdated, ...result.closedFilesWritten],
    unsaved,
  };
}
