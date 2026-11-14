/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace edit proposal
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An edit of several documents that the author sees before
 *                  a file changes: the edits, the hash of each document
 *                  they were made on, and each changed line before and
 *                  after. The main process sends a proposal to the window
 *                  that started the action; the window applies or
 *                  discards it.
 *
 * END HEADER
 */

import type { WorkspaceTextEdit } from "./references";

/** The channel on which the main process sends a proposal to a window. */
export const WORKSPACE_EDIT_PROPOSAL_CHANNEL = "workspace-edit-proposal";

/** One changed run of lines: the text before and after, without the last line end. */
export interface WorkspaceEditLineChange {
  /** The line of the document, from 1, where the run starts. */
  line: number;
  before: string;
  after: string;
}

/** The changed lines of one document. */
export interface WorkspaceEditDocumentPreview {
  documentPath: string;
  changes: WorkspaceEditLineChange[];
}

/** An edit of the workspace that waits for the author. */
export interface WorkspaceEditProposal {
  id: string;
  /** What the edit does, in a few words. */
  title: string;
  /** Why the edit is offered: the action of the author that caused it. */
  description: string;
  edits: WorkspaceTextEdit[];
  /** The hash of the text of each document that the edits were made on. */
  expectedSourceHashes: Record<string, string>;
  /** The documents in the order of the preview. */
  documents: WorkspaceEditDocumentPreview[];
}
