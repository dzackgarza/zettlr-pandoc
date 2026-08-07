/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiffStore
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Committed review state, and the read projections over it.
 *                  One active review per document, keyed by documentId (not
 *                  path).
 *
 *                  State model — deliberately minimal:
 *                    referenceText = accepted state + rejected restorations,
 *                                    owned HERE and nowhere else
 *                    working text  = the live document, owned by the document
 *                                    authority and PASSED IN to every read —
 *                                    the store holds no copy and resolves no
 *                                    text of its own
 *                    chunks        = computeReviewChunks(reference, working),
 *                                    derived on demand by the one shared
 *                                    engine, never stored
 *
 *                  The store decides nothing. Transitions live in
 *                  review-transitions.ts and are pure; the caller commits a
 *                  plan by calling replaceReview or removeReview. That split
 *                  is what lets a refused mutation leave no residue: no
 *                  state was touched to begin with, so there is nothing to
 *                  unwind, and no ordering of cleanup to get right.
 *
 * END HEADER
 */

import { createPatch } from "diff";
import type {
  OutstandingChunk,
  ProposalPacket,
  ReviewState,
} from "@dts/common/agent-api";
import type {
  ActiveReviewState,
  ChunkComment,
  ReviewPacket,
} from "@dts/common/review-domain";
import {
  chunkAttributesTo,
  computeReviewChunks,
  type ReviewChunk,
} from "@common/modules/review/review-chunks";
import { sha256Text } from "@common/util/sha256";
import type { ReviewSidecarData } from "./review-sidecar-schema";

export type { ReviewSidecarData };

// ============================================================================
// Persisted shape
// ============================================================================

/** What a status read reports about one review. */
export interface ReviewStatus {
  reviewId: string;
  state: ReviewState;
  generation: number;
  unresolvedChunks: number;
  packetCount: number;
}

// ============================================================================
// Shared primitives
// ============================================================================

export function normalizeText(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n\r|\n|\r/g)
    .join("\n");
}

/**
 * The identity of a proposal request: what makes a replayed clientRequestId
 * the SAME request rather than a conflicting reuse of the id. Serialization
 * is a fixed literal field order — including inside each claim, because the
 * claim objects arrive from JSON and their key order is the client's, not
 * ours. Nothing here needs a general canonical-JSON framework.
 */
export function proposalRequestFingerprint(request: {
  documentId: string;
  baselineSha256: string;
  expectedReviewGeneration: number;
  claims: ReadonlyArray<{ description: string; patch: string }>;
}): string {
  return sha256Text(
    JSON.stringify({
      documentId: request.documentId,
      baselineSha256: request.baselineSha256,
      expectedReviewGeneration: request.expectedReviewGeneration,
      claims: request.claims.map((claim) => ({
        description: claim.description,
        patch: claim.patch,
      })),
    }),
  );
}

/**
 * A stored packet as the API publishes it: the ledger entry alone. The
 * attribution spans are internal, and the patch format is a constant of the
 * contract rather than a per-packet fact.
 */
export function toWirePacket(packet: ReviewPacket): ProposalPacket {
  return {
    packetId: packet.packetId,
    reviewId: packet.reviewId,
    clientRequestId: packet.clientRequestId,
    description: packet.description,
    appliedAt: packet.appliedAt,
    patchFormat: "unified-diff",
    patch: packet.patch,
    applicationGeneration: packet.applicationGeneration,
  };
}

/**
 * The one review-state rule, shared by the live store and the sidecar-backed
 * listing so an attached and a detached review with the same facts can never
 * classify differently.
 */
export function classifyReviewState(
  invalidated: boolean,
  unresolvedChunks: number,
): ReviewState {
  if (invalidated) {
    return "invalidated";
  }
  return unresolvedChunks === 0 ? "resolved-awaiting-save" : "active";
}

/**
 * The composite unresolved patch of a review: reference → working. The one
 * owner of that computation, so the live store and a detached review read
 * from its sidecar cannot answer different diffs for the same two texts.
 */
export function reviewPatch(referenceText: string, workingText: string): string {
  return createPatch("document", referenceText, workingText, "", "", { context: 3 });
}

/**
 * A chunk partition dressed for the agent API: a focused zero-context patch
 * per chunk, the packets whose edits produced it (honest multi-attribution on
 * overlap; empty for a chunk only the user's own edits created), and the
 * reviewer's note when one is attached. Shared by the live store and the
 * sidecar path below — an attached and a detached review with the same texts
 * describe their chunks identically.
 */
function dressChunks(
  partition: readonly ReviewChunk[],
  packets: readonly ReviewPacket[],
  chunkComments: readonly ChunkComment[],
): OutstandingChunk[] {
  return partition.map((chunk) => {
    const attributed = packets.filter((packet) => chunkAttributesTo(chunk, packet.refSpans));
    const note = chunkComments.find((candidate) => candidate.chunkId === chunk.chunkId);
    return {
      chunkId: chunk.chunkId,
      referenceRange: { fromLine: chunk.refFromLine, toLine: chunk.refToLine },
      workingRange: { fromLine: chunk.workFromLine, toLine: chunk.workToLine },
      referenceText: chunk.referenceText,
      workingText: chunk.workingText,
      packetIds: attributed.map((packet) => packet.packetId),
      descriptions: attributed.map((packet) => packet.description),
      ...(note === undefined ? {} : { comment: note.comment }),
      patch: createPatch("document", chunk.referenceText, chunk.workingText, "", "", {
        context: 0,
      }),
    };
  });
}

/**
 * The outstanding chunks of a detached review, computed from its sidecar.
 * Both texts are frozen while the file is closed and the export reconciled
 * the chunk comments against exactly this partition, so no live document —
 * and no reconciliation — is needed to answer.
 */
export function sidecarOutstandingChunks(sidecar: ReviewSidecarData): OutstandingChunk[] {
  return dressChunks(
    computeReviewChunks(sidecar.referenceText, sidecar.workingText),
    sidecar.packets,
    sidecar.chunkComments,
  );
}

// ============================================================================
// Sidecar (de)serialization
// ============================================================================

/**
 * Serialize a review for its sidecar: everything reviewFromSidecar needs to
 * rebuild identical state, and nothing derived from it. The working text is
 * passed in because its owner is the document, not this module.
 */
export function reviewSidecar(
  review: ActiveReviewState,
  workingText: string,
  pendingSave?: ReviewSidecarData["pendingSave"],
): ReviewSidecarData {
  return {
    version: 3,
    reviewId: review.reviewId,
    documentPath: review.documentPath,
    referenceText: review.referenceText,
    workingText,
    generation: review.generation,
    diskFenceSha256: review.diskFenceSha256,
    invalidated: review.invalidated,
    packets: review.packets.map((packet) => ({
      ...packet,
      refSpans: packet.refSpans.map((span) => ({ ...span })),
    })),
    submissions: review.submissions.map((submission) => ({
      ...submission,
      packetIds: [...submission.packetIds],
    })),
    chunkComments: review.chunkComments.map((note) => ({ ...note })),
    comments: review.comments.map((comment) => ({ ...comment })),
    ...(pendingSave === undefined ? {} : { pendingSave }),
  };
}

/**
 * The unresolved chunk count of a detached review, computed from its sidecar.
 * Nothing derived is persisted: the two texts are the whole answer, and a
 * stored count is a second answer that can disagree with them.
 */
export function sidecarUnresolvedChunks(sidecar: ReviewSidecarData): number {
  return computeReviewChunks(sidecar.referenceText, sidecar.workingText).length;
}

/**
 * Rebuild a review from its sidecar under a (possibly new) documentId. The
 * inverse of reviewSidecar: same reviewId, generation, packets with their
 * attribution spans, submission ledger, chunk comments, and comments — and
 * because chunk ids are content-addressed over the two texts, the same
 * chunk ids.
 */
export function reviewFromSidecar(
  documentId: string,
  sidecar: ReviewSidecarData,
): ActiveReviewState {
  return {
    reviewId: sidecar.reviewId,
    documentId,
    documentPath: sidecar.documentPath,
    referenceText: sidecar.referenceText,
    generation: sidecar.generation,
    packets: sidecar.packets.map((packet) => ({
      ...packet,
      refSpans: packet.refSpans.map((span) => ({ ...span })),
    })),
    submissions: sidecar.submissions.map((submission) => ({
      ...submission,
      packetIds: [...submission.packetIds],
    })),
    chunkComments: sidecar.chunkComments.map((note) => ({ ...note })),
    comments: sidecar.comments.map((comment) => ({ ...comment })),
    diskFenceSha256: sidecar.diskFenceSha256,
    invalidated: sidecar.invalidated,
  };
}

// ============================================================================
// ReviewDiffStore
// ============================================================================

/**
 * Committed review state and the read projections over it. No I/O, no
 * events, no idempotency, no text resolver: every projection is a function
 * of a stored review and the working text its caller supplies.
 */
export class ReviewDiffStore {
  private readonly reviews: Map<string, ActiveReviewState> = new Map();

  getReview(documentId: string): ActiveReviewState | undefined {
    return this.reviews.get(documentId);
  }

  findReviewByReviewId(reviewId: string): ActiveReviewState | undefined {
    for (const review of this.reviews.values()) {
      if (review.reviewId === reviewId) {
        return review;
      }
    }
    return undefined;
  }

  /** Commit a candidate review as the state of record for its document. */
  replaceReview(documentId: string, review: ActiveReviewState): void {
    this.reviews.set(documentId, review);
  }

  removeReview(documentId: string): void {
    this.reviews.delete(documentId);
  }

  listReviews(): ActiveReviewState[] {
    return [...this.reviews.values()];
  }

  getStatus(documentId: string, workingText: string): ReviewStatus | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    const partition = computeReviewChunks(
      review.referenceText,
      normalizeText(workingText),
    );
    const unresolvedChunks = partition.length;
    return {
      reviewId: review.reviewId,
      state: classifyReviewState(review.invalidated, unresolvedChunks),
      generation: review.generation,
      unresolvedChunks,
      packetCount: review.packets.length,
    };
  }

  /**
   * The current outstanding chunks — the shared partition dressed for the
   * agent API, with a focused zero-context patch per chunk and the packets
   * whose edits produced it (honest multi-attribution on overlap; empty for
   * a chunk only the user's own edits created).
   */
  getOutstandingChunks(
    documentId: string,
    workingText: string,
  ): OutstandingChunk[] | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    return dressChunks(
      computeReviewChunks(review.referenceText, normalizeText(workingText)),
      review.packets,
      review.chunkComments,
    );
  }

  /** The composite unresolved patch: referenceText → working text. */
  getReviewDiff(documentId: string, workingText: string): string | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    return reviewPatch(review.referenceText, normalizeText(workingText));
  }
}
