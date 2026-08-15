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

import type { ReviewComment, SubmitProposalResponse } from "./agent-api";

/**
 * One applied claim: the ledger entry and its reference-side edit footprint,
 * in ONE object. The spans were previously kept in a parallel map keyed by
 * `patchFormat` is not stored: the API supports exactly one format, and the
 * wire packet stamps it. Suggestion entities own all adjudication anchors
 * and refer to their source packet by stable identity.
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
}

export interface SuggestionSpan {
  from: number;
  to: number;
}

export interface ReviewSuggestion {
  suggestionId: string;
  packetId: string;
  kind: "insertion" | "deletion" | "substitution";
  removedText: string;
  restorations: Array<{ at: number; text: string }>;
  anchors: SuggestionSpan[];
  seam: number;
  state: "proposed" | "accepted" | "rejected" | "withdrawn";
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
 * A comment attached to one stable suggestion WITHOUT deciding it.
 */
export interface ChunkComment {
  chunkId: string;
  comment: string;
  commentedAt: string; // ISO 8601 timestamp
}

export interface ActiveReviewState {
  reviewId: string;
  documentId: string;
  /** Stored for patch header validation on every submission. */
  documentPath: string;
  suggestions: ReviewSuggestion[];
  generation: number;
  packets: ReviewPacket[];
  /** The idempotency ledger, in submission order. */
  submissions: ProposalSubmissionRecord[];
  /**
   * Comments keyed by stable suggestion id. They remain attached to that
   * entity through owner edits and adjudication.
   */
  chunkComments: ChunkComment[];
  /** Review-level comments, in creation order. */
  comments: ReviewComment[];
  diskFenceSha256: string;
  /** True after external disk drift invalidated the review. */
  invalidated: boolean;
}
