/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Text annotation domain
 * CVM-Role:        Types
 * Maintainer:       D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     An annotation is the owner's comment on a stretch of one
 *                  document, and it outlives every review that answers it. It
 *                  is therefore its own aggregate rather than a field on
 *                  review state: a review ends, and the annotation and its
 *                  thread stay.
 *
 *                  The anchor is the only part of an annotation the document
 *                  can change. It has three states because the text under a
 *                  comment can survive, be deleted, or drift away underneath
 *                  the application — and the three want different treatment
 *                  in the editor and different actions in the panel. The
 *                  quoted text is carried in all three and never rewritten,
 *                  so a reader can always see what was commented on even when
 *                  nothing is left to point at.
 *
 * END HEADER
 */

export type AnnotationAnchor =
  /** The target text is still there, between these two offsets. */
  | { state: "range"; from: number; to: number; quotedText: string }
  /** The owner deleted the target. The seam is where it stood. */
  | { state: "point"; at: number; quotedText: string; reason: "target-deleted" }
  /** Nothing in the document can be said to be the target any more. */
  | {
      state: "orphaned";
      quotedText: string;
      reason: "external-drift" | "unmapped-document-change";
    };

/**
 * One turn of the conversation. The owner's first message is the instruction
 * the annotation exists to carry; a card's title is derived from it and never
 * stored. An agent's message carries the request id that wrote it, so a
 * retried post is recognised rather than duplicated.
 */
export type AnnotationMessage =
  | { messageId: string; author: "owner"; text: string; createdAt: string }
  | {
      messageId: string;
      author: "agent";
      clientRequestId: string;
      text: string;
      createdAt: string;
    };

/**
 * A proposal an agent submitted against this annotation, recorded at the
 * packet it arrived in. The outcome is absent until the owner adjudicates it.
 */
export interface AnnotationProposalAction {
  actionId: string;
  packetId: string;
  reviewId: string;
  linkedAt: string;
  terminalOutcome?: "accepted" | "rejected" | "mixed" | "withdrawn" | "cleared";
}

export interface TextAnnotation {
  annotationId: string;
  documentId: string;
  anchor: AnnotationAnchor;
  state: "open" | "resolved";
  /** Never empty: an annotation is created by its first message. */
  messages: [AnnotationMessage, ...AnnotationMessage[]];
  proposalActions: AnnotationProposalAction[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}
