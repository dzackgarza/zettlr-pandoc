/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document collaboration renderer snapshot
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one shape every renderer pane and the annotations
 *                  panel read collaboration state from. It carries both
 *                  halves of a document's collaboration state — its
 *                  annotations and its review, if one is active — because a
 *                  pane that read them from two separate broadcasts could
 *                  observe one half updated and the other still stale.
 *
 *                  This is the ONLY collaboration shape a renderer surface
 *                  may read: it is broadcast on DP_EVENTS.DOCUMENT_COLLABORATION
 *                  and cached in the document-collaboration Pinia store, and
 *                  nothing downstream of that store may go around it to read
 *                  the sidecar directly.
 *
 * END HEADER
 */

import type { AnnotationSet } from "./annotation-domain";
import type { ReviewDiffSession } from "./review-diff";

export interface DocumentCollaborationSession {
  documentId: string;
  documentPath: string;
  /** The provider-authoritative working bytes this snapshot was taken from. */
  workingText: string;
  workingSha256: string;
  /** Never absent: an annotation-only document reports an empty set. */
  annotations: AnnotationSet;
  /** Absent when the document carries no active review. */
  review: ReviewDiffSession | undefined;
}

/**
 * A file of collaboration state that this version of the application cannot
 * read: a later version wrote it, or it is damaged. The file stays where it
 * is until the author moves it aside.
 */
export interface UnreadableCollaborationFile {
  /** The absolute path of the file in the application data. */
  file: string;
  /** Why the file could not be read. */
  cause: string;
  /** The document that the file belongs to, when the listing names it. */
  documentPath: string | undefined;
}

/**
 * A file of collaboration state whose document has no file: the author
 * deleted the document, or a move of the document could not carry the
 * state. The file stays where it is until the author moves it aside.
 */
export interface OwnerlessCollaborationFile {
  /** The absolute path of the file in the application data. */
  file: string;
  /** The path that the state belongs to, where no file is. */
  documentPath: string;
}

/** The collaboration state of the documents of a workspace. */
export interface WorkspaceCollaborationListing {
  sessions: DocumentCollaborationSession[];
  /** The files that could not be read. Their state is in no session. */
  unreadable: UnreadableCollaborationFile[];
  /**
   * The files whose document has no file, for the documents of the open
   * workspaces. Their state is in no session.
   */
  ownerless: OwnerlessCollaborationFile[];
}

/**
 * Broadcast on COLLABORATION_FILE_UNREADABLE_CHANNEL when a document opened
 * without its annotations and its review, because their file could not be
 * read. The window offers to move the file aside.
 */
export type CollaborationFileUnreadableBroadcast = {
  filePath: string;
  file: string;
  cause: string;
};

export const COLLABORATION_FILE_UNREADABLE_CHANNEL = "collaboration-sidecar-unreadable";
