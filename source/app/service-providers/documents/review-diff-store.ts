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
 *                  Suggestions are the stored review entities. Their stable
 *                  identities, anchors, and restorations drive every read.
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
  ReviewSuggestion,
} from "@dts/common/review-domain";
import { sha256Text } from "@common/util/sha256";
import type { CollaborationSidecarData, PersistedReviewState } from "./collaboration-sidecar-schema";

/** A sidecar known, at the type level, to carry an open review. */
export type ReviewBearingSidecar = CollaborationSidecarData & { review: PersistedReviewState };

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
export function reviewReferenceText(
  suggestions: readonly ReviewSuggestion[],
  workingText: string,
): string {
  const operations = suggestions
    .filter((suggestion) => suggestion.state === "proposed")
    .flatMap((suggestion) => [
      ...suggestion.anchors.map((span) => ({ from: span.from, to: span.to, insert: "" })),
      ...suggestion.restorations.map((restoration) => ({
        from: restoration.at,
        to: restoration.at,
        insert: restoration.text,
      })),
    ])
    .sort((left, right) => right.from - left.from || right.to - left.to);
  let referenceText = workingText;
  for (const operation of operations) {
    referenceText =
      referenceText.slice(0, operation.from) +
      operation.insert +
      referenceText.slice(operation.to);
  }
  return referenceText;
}

export function reviewPatch(
  suggestions: readonly ReviewSuggestion[],
  workingText: string,
): string {
  return createPatch(
    "document",
    reviewReferenceText(suggestions, workingText),
    workingText,
    "",
    "",
    { context: 3 },
  );
}

/**
 * Suggestion entities dressed for the agent API, with disjoint working spans,
 * their source packet, and the reviewer's note. Shared by the live
 * store and the sidecar path below. Attached and detached reviews therefore
 * project the same suggestion entities.
 */
function dressSuggestions(
  suggestions: readonly ReviewSuggestion[],
  workingText: string,
  packets: readonly ReviewPacket[],
  chunkComments: readonly ChunkComment[],
): OutstandingChunk[] {
  return suggestions
    .filter((suggestion) => suggestion.state === "proposed")
    .map((suggestion) => {
      const packet = packets.find((candidate) => candidate.packetId === suggestion.packetId);
      const proposedText = suggestion.anchors
        .map((span) => workingText.slice(span.from, span.to))
        .join("");
      const workingSpans = suggestion.anchors.map((span) => ({ ...span }));
      const note = chunkComments.find((candidate) => candidate.chunkId === suggestion.suggestionId);
      return {
        chunkId: suggestion.suggestionId,
        referenceText: suggestion.removedText,
        workingText: proposedText,
        workingSpans,
        packetIds: [suggestion.packetId],
        descriptions: packet === undefined ? [] : [packet.description],
        ...(note === undefined ? {} : { comment: note.comment }),
        patch: createPatch("document", suggestion.removedText, proposedText, "", "", { context: 0 }),
      };
    });
}

/**
 * The outstanding chunks of a detached review, computed from its sidecar.
 * The sidecar stores the working text and suggestion entities. No live
 * document or reconstruction is needed to answer.
 */
export function sidecarOutstandingChunks(sidecar: ReviewBearingSidecar): OutstandingChunk[] {
  return dressSuggestions(
    sidecar.review.suggestions,
    sidecar.workingText,
    sidecar.review.packets,
    sidecar.review.chunkComments,
  );
}

// ============================================================================
// Sidecar (de)serialization
// ============================================================================

/**
 * Serialize a review for its sidecar: everything reviewFromSidecar needs to
 * rebuild identical state, and nothing derived from it. The working text is
 * passed in because its owner is the document, not this module.
 *
 * ponytail: annotations always come back empty here. Nothing on this path
 * knows about a document's annotation state yet — the transaction boundary
 * that reads-modifies-writes the whole sidecar (review AND annotations) in
 * one persist is M3's unified mutation pipeline. Until that lands, a review
 * mutation cannot silently drop annotations because nothing before M3 can
 * create one.
 */
export function reviewSidecar(
  review: ActiveReviewState,
  workingText: string,
  pendingSave?: CollaborationSidecarData["pendingSave"],
): CollaborationSidecarData {
  return {
    version: 5,
    documentPath: review.documentPath,
    workingText,
    diskFenceSha256: review.diskFenceSha256,
    review: {
      reviewId: review.reviewId,
      generation: review.generation,
      invalidated: review.invalidated,
      packets: review.packets.map((packet) => ({ ...packet })),
      suggestions: review.suggestions.map((suggestion) => ({
        ...suggestion,
        anchors: suggestion.anchors.map((span) => ({ ...span })),
        restorations: suggestion.restorations.map((restoration) => ({ ...restoration })),
      })),
      submissions: review.submissions.map((submission) => ({
        ...submission,
        packetIds: [...submission.packetIds],
      })),
      chunkComments: review.chunkComments.map((note) => ({ ...note })),
      comments: review.comments.map((comment) => ({ ...comment })),
    },
    annotations: { generation: 0, items: [] },
    ...(pendingSave === undefined ? {} : { pendingSave }),
  };
}

/**
 * The unresolved suggestion count of a detached review.
 */
export function sidecarUnresolvedChunks(sidecar: ReviewBearingSidecar): number {
  return sidecar.review.suggestions.filter((suggestion) => suggestion.state === "proposed").length;
}

/**
 * Rebuild a review from its sidecar under a (possibly new) documentId. The
 * inverse of reviewSidecar: same reviewId, generation, packets, suggestions,
 * submission ledger, chunk comments, and review comments.
 */
export function reviewFromSidecar(
  documentId: string,
  sidecar: CollaborationSidecarData,
): ActiveReviewState {
  if (sidecar.review === null) {
    throw new Error(`Collaboration sidecar for ${sidecar.documentPath} has no review to restore`);
  }
  const review = sidecar.review;
  return {
    reviewId: review.reviewId,
    documentId,
    documentPath: sidecar.documentPath,
    suggestions: review.suggestions.map((suggestion) => ({
      ...suggestion,
      anchors: suggestion.anchors.map((span) => ({ ...span })),
      restorations: suggestion.restorations.map((restoration) => ({ ...restoration })),
    })),
    generation: review.generation,
    packets: review.packets.map((packet) => ({ ...packet })),
    submissions: review.submissions.map((submission) => ({
      ...submission,
      packetIds: [...submission.packetIds],
    })),
    chunkComments: review.chunkComments.map((note) => ({ ...note })),
    comments: review.comments.map((comment) => ({ ...comment })),
    diskFenceSha256: sidecar.diskFenceSha256,
    invalidated: review.invalidated,
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

  getStatus(documentId: string, _workingText: string): ReviewStatus | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    const unresolvedChunks = review.suggestions.filter((suggestion) => suggestion.state === "proposed").length;
    return {
      reviewId: review.reviewId,
      state: classifyReviewState(review.invalidated, unresolvedChunks),
      generation: review.generation,
      unresolvedChunks,
      packetCount: review.packets.length,
    };
  }

  /**
   * The current proposed suggestions dressed for the agent API.
   */
  getOutstandingChunks(
    documentId: string,
    workingText: string,
  ): OutstandingChunk[] | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    return dressSuggestions(
      review.suggestions,
      normalizeText(workingText),
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
    return reviewPatch(review.suggestions, normalizeText(workingText));
  }
}
