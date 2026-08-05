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

import type { RefSpan } from "@common/modules/review/review-chunks";
import type { ReviewComment, SubmitProposalResponse } from "./agent-api";

/**
 * One applied claim: the ledger entry and its reference-side edit footprint,
 * in ONE object. The spans were previously kept in a parallel map keyed by
 * packetId, which had to be restored, remapped, and cleaned up in lockstep
 * with the packet array — three places to forget. A packet now carries the
 * spans it owns, so attribution moves with the packet by construction.
 *
 * `patchFormat` is not stored: the API supports exactly one format, and the
 * wire packet stamps it. `refSpans` are half-open, 1-based line intervals in
 * the merge reference, remapped across every decision.
 */
export interface ReviewPacket {
  packetId: string;
  reviewId: string;
  clientRequestId: string;
  requestFingerprint: string;
  description: string;
  appliedAt: string;
  patch: string;
  /** The review generation this packet's application produced. */
  applicationGeneration: number;
  refSpans: RefSpan[];
}

/**
 * One committed proposal submission: the idempotency ledger entry. Replaying
 * a clientRequestId with the same fingerprint returns `response` unchanged;
 * replaying it with a different fingerprint is IDEMPOTENCY_CONFLICT. The
 * ledger lives in the review and is persisted with it, so a replay survives
 * detach, reopen, and restart for exactly as long as the review does.
 */
export interface ProposalSubmissionRecord {
  clientRequestId: string;
  requestFingerprint: string;
  packetIds: string[];
  response: SubmitProposalResponse;
}

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
  /** Stored for patch header validation on every submission. */
  documentPath: string;
  /**
   * Evolving merge reference: accepted state + rejected restorations. This is
   * the ONLY text a review stores. The working text is the live document,
   * owned by the document authority and read through the store's resolver —
   * a mirrored copy here is what previously let the two drift apart.
   */
  referenceText: string;
  generation: number;
  packets: ReviewPacket[];
  /** The idempotency ledger, in submission order. */
  submissions: ProposalSubmissionRecord[];
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
