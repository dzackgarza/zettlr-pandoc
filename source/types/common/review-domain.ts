/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Internal review state
 * CVM-Role:         Types
 * Maintainer:       D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     The mutable review state the main process owns. These are
 *                  not wire shapes: the OpenAPI document describes what a
 *                  client is handed, and this describes what the store edits.
 *                  A generated response type used as mutable state ties the
 *                  two together, and the published contract then changes
 *                  whenever the internal state does.
 *
 * END HEADER
 */

import type { ProposalPacket, ReviewComment } from "./agent-api";

/**
 * A hold: a comment attached to a chunk WITHOUT adjudicating it (the comment
 * is optional — a hold without text is legal). Held chunks are excluded from
 * the save-gate count and survive a save; the reference simply retains its
 * disagreement over that span. Holds are keyed by content-addressed chunkId,
 * so an edit inside a held chunk orphans the hold: its comment surfaces as a
 * review-level ReviewComment carrying orphanedFromChunkId.
 */
export interface ChunkHold {
  chunkId: string;
  comment?: string;
  heldAt: string; // ISO 8601 timestamp
  /** Snapshot used to reattach the hold when unrelated lines shift. */
  referenceText?: string;
  workingText?: string;
  referenceFromLine?: number;
  workingFromLine?: number;
}

export interface ActiveReviewState {
  reviewId: string;
  documentId: string;
  /** Stored for patch header validation in submitPacket. */
  documentPath: string;
  /** The initial baseline text when the review opened. Does not change. */
  baselineText: string;
  /**
   * Evolving merge reference: accepted state + rejected restorations. This is
   * the ONLY text a review stores. The working text is the live document,
   * owned by the document authority and read through the store's resolver —
   * a mirrored copy here is what previously let the two drift apart.
   */
  referenceText: string;
  generation: number;
  packets: ProposalPacket[];
  /**
   * Chunk holds, reconciled lazily against the live partition: a hold whose
   * chunk id no longer exists is removed, and its comment (if any) moves to
   * `comments` as an orphan.
   */
  holds: ChunkHold[];
  /** Review-level comments, in creation order. */
  comments: ReviewComment[];
  diskFenceSha256: string;
  /** True after external disk drift invalidated the review. */
  invalidated: boolean;
}
