/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiffStore
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Provider-owned review state. One active review per
 *                  document, keyed by documentId (not path).
 *
 *                  State model — deliberately minimal:
 *                    referenceText = accepted state + rejected restorations,
 *                                    owned HERE and nowhere else
 *                    working text  = the live document, owned by the document
 *                                    authority and READ through a resolver —
 *                                    the store holds no copy
 *                    chunks        = computeReviewChunks(reference, working),
 *                                    derived on demand by the one shared
 *                                    engine, never stored
 *
 *                  The previous model mirrored the working text here and let
 *                  renderer panes report an evolved referenceText back, which
 *                  meant two owners per text and a reconciliation protocol
 *                  (generation checks, version checks, text equality checks,
 *                  re-broadcasts) to paper over the divergence. Both copies
 *                  are gone: mutations that change the working text RETURN
 *                  the new text for the document owner to apply, and the
 *                  reference is only ever changed by accept/reject decisions
 *                  arriving through the provider.
 *
 *                  Transitions:
 *                    incoming proposal → new working text (returned to owner)
 *                    accept chunk      → referenceText agrees with working
 *                    reject chunk      → new working text agrees with
 *                                        reference (returned to owner)
 *
 * END HEADER
 */

import { createHash, randomUUID } from "crypto";
import EventEmitter from "events";
import {
  applyPatch,
  parsePatch,
  reversePatch,
  createPatch,
  type StructuredPatch,
} from "diff";
import path from "path";
import type {
  ActiveReviewState,
  ProposalPacket,
  ReviewState,
  OutstandingChunk,
  AgentEvent,
} from "@dts/common/agent-api";
import {
  computeReviewChunks,
  spliceChunk,
  type ReviewChunk,
} from "@common/modules/review/review-chunks";

// ============================================================================
// Types
// ============================================================================

export interface OpenReviewOptions {
  documentId: string;
  documentPath: string;
  baselineText: string;
  diskBaselineSha256: string;
  /** Optional: use a caller-provided reviewId instead of generating one. */
  reviewId?: string;
  /** Optional: initial patch to apply (first proposal packet) */
  initialPatch?: {
    patchFormat: "unified-diff";
    patch: string;
    description?: string;
    clientRequestId?: string;
  };
}

export interface OpenReviewResult {
  state: ActiveReviewState;
  /**
   * The text the document must now show. The store holds no working text;
   * applying this to the live document is the caller's obligation.
   */
  workingText: string;
}

export interface SubmitPacketOptions {
  patchFormat: "unified-diff";
  patch: string;
  description?: string;
  clientRequestId: string;
  expectedReviewGeneration?: number;
}

export interface SubmitPacketResult {
  ok: true;
  packetId: string;
  reviewId: string;
  generation: number;
  /** The text the document must now show. */
  workingText: string;
  unresolvedChunks: number;
  state: ReviewState;
}

export interface SubmitPacketError {
  ok: false;
  code:
    | "PATCH_INVALID"
    | "PATCH_NOT_APPLICABLE"
    | "REVIEW_NOT_FOUND"
    | "REVIEW_INVALIDATED"
    | "REVISION_MISMATCH"
    | "CHUNK_NOT_FOUND";
  message: string;
}

export interface ClearUnresolvedResult {
  ok: true;
  reviewId: string;
  documentId: string;
  /** The text the document must now show (the reference). */
  workingText: string;
  referenceText: string;
  generation: number;
  unresolvedChunks: 0;
  state: ReviewState;
}

export interface RetractPacketResult {
  ok: true;
  packetId: string;
  reviewId: string;
  documentId: string;
  generation: number;
  /** The text the document must now show (the packet reverted). */
  workingText: string;
  unresolvedChunks: number;
}

export interface RetractPacketError {
  ok: false;
  code: "PACKET_NOT_RETRACTABLE";
  message: string;
  reviewId: string;
  canClearUnresolved: true;
}

export interface ChunkDecisionResult {
  ok: true;
  reviewId: string;
  documentId: string;
  chunkId: string;
  decision: "accept" | "reject";
  generation: number;
  /**
   * Present only for reject: the text the document must now show. Accepting
   * touches the reference alone and leaves the document as it is.
   */
  workingText?: string;
  unresolvedChunks: number;
  state: ReviewState;
}

// ============================================================================
// Helpers
// ============================================================================

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function normalizeText(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n\r|\n|\r/g)
    .join("\n");
}

/**
 * Parse exactly one text-file patch and validate it. Reject binary, create,
 * delete, rename, copy, and mode changes.
 */
export function validateAndParsePatch(
  patchText: string,
  documentPath: string,
): StructuredPatch {
  // Detect git binary patches before parsePatch (which doesn't parse them)
  if (patchText.includes("GIT binary patch")) {
    throw new Error("review-diff does not support binary patches");
  }
  const patches = parsePatch(patchText);
  if (patches.length !== 1) {
    throw new Error("review-diff requires exactly one file patch");
  }
  const patch = patches[0];
  if (patch.hunks.length === 0) {
    throw new Error("review-diff patch does not change the target document");
  }
  if (patch.isBinary === true) {
    throw new Error("review-diff does not support binary patches");
  }
  if (
    patch.isRename === true ||
    patch.isCopy === true ||
    patch.isCreate === true ||
    patch.isDelete === true
  ) {
    throw new Error(
      "review-diff does not support rename, copy, create, or delete patches",
    );
  }
  if (patch.oldMode !== undefined || patch.newMode !== undefined) {
    throw new Error("review-diff does not support mode-change patches");
  }
  if (patch.oldFileName === "/dev/null" || patch.newFileName === "/dev/null") {
    throw new Error("review-diff does not support create or delete patches");
  }
  // Headers must be either the exact canonical document URI or the generic
  // "--- document" / "+++ document". Basename matching is too weak.
  if (
    !isAcceptableHeader(patch.oldFileName, documentPath) ||
    !isAcceptableHeader(patch.newFileName, documentPath)
  ) {
    throw new Error(
      "review-diff patch headers do not match the target document",
    );
  }
  return patch;
}

function isAcceptableHeader(
  fileName: string | undefined,
  documentPath: string,
): boolean {
  if (fileName === undefined) {
    return false;
  }
  // Generic headers
  const normalized = fileName.replace(/\\/g, "/");
  if (
    normalized === "document" ||
    normalized === "a/document" ||
    normalized === "b/document"
  ) {
    return true;
  }
  // Exact canonical path. The contract accepts `document`, an absolute path, or
  // an absolute path behind a git-style a/ or b/ prefix — nothing relative.
  //
  // `git diff` drops the leading slash when it prefixes an absolute path, so
  // `a//home/x.md` arrives as `a/home/x.md`; the root is restored ONLY for a
  // header that actually carried that prefix. Restoring it unconditionally
  // would accept a bare relative header like `home/x.md` as `/home/x.md`,
  // which is precisely the target check this function exists to perform.
  const gitPrefix = /^(a|b)\//;
  const carriedPrefix = gitPrefix.test(normalized);
  const stripped = normalized.replace(gitPrefix, "");
  if (path.isAbsolute(stripped)) {
    return path.resolve(stripped) === path.resolve(documentPath);
  }
  if (!carriedPrefix) {
    return false;
  }
  return path.resolve(`/${stripped}`) === path.resolve(documentPath);
}

// ============================================================================
// ReviewDiffStore
// ============================================================================

/**
 * Provider-owned review state. The main process owns all agent-visible state;
 * this store is the single source of truth for the evolving merge reference,
 * and reads the working text from the document authority through the resolver
 * it is constructed with.
 *
 * Events emitted:
 *  - 'review.started'   { reviewId, documentId }
 *  - 'proposal.applied'  { reviewId, documentId, packetId, generation, unresolvedChunks }
 *  - 'proposal.retracted'{ reviewId, documentId, packetId, generation, unresolvedChunks }
 *  - 'review.changed'    { reviewId, documentId, generation, unresolvedChunks }
 *  - 'review.resolved'   { reviewId, documentId, generation }
 *  - 'review.completed'  { reviewId, documentId }
 *  - 'review.cleared'    { reviewId, documentId }
 *  - 'review.invalidated'{ reviewId, documentId }
 */
export class ReviewDiffStore extends EventEmitter {
  private readonly reviews: Map<string, ActiveReviewState> = new Map();
  /** Index from clientRequestId → packetId for idempotency */
  private readonly idempotencyIndex: Map<string, SubmitPacketResult> =
    new Map();
  /** Index from packetId → reviewId for retraction lookup */
  private readonly packetIndex: Map<string, string> = new Map();

  /**
   * @param getWorkingText Resolves a documentId to the live document text.
   *                       The document authority owns the working text; the
   *                       store never holds a copy of it.
   */
  constructor(
    private readonly getWorkingText: (documentId: string) => string | undefined,
  ) {
    super();
  }

  /**
   * The live document text for an active review. Throws when the document is
   * gone: a review outliving its document is a lifecycle bug (closeReview
   * must run when a document closes), and silently treating it as empty or
   * resolved would hide that bug behind a plausible-looking answer.
   */
  private workingTextOf(documentId: string): string {
    const text = this.getWorkingText(documentId);
    if (text === undefined) {
      throw new Error(
        `Review state exists for document ${documentId} but the document is not open`,
      );
    }
    return normalizeText(text);
  }

  /** The current chunk partition for an active review. */
  private partitionOf(review: ActiveReviewState): ReviewChunk[] {
    return computeReviewChunks(
      review.referenceText,
      this.workingTextOf(review.documentId),
    );
  }

  /**
   * Open a new review session for a document. Returns the new review state
   * and the working text the caller must apply to the live document.
   * Throws if a review is already active for this documentId.
   */
  openReview(options: OpenReviewOptions): OpenReviewResult {
    if (this.reviews.has(options.documentId)) {
      throw new Error(
        `A review is already active for document ${options.documentId}`,
      );
    }

    const baselineText = normalizeText(options.baselineText);

    const referenceText = baselineText;
    let workingText = baselineText;
    let packets: ProposalPacket[] = [];
    let generation = 0;
    let initialPacketId: string | undefined;
    let initialReviewId: string | undefined;

    if (options.initialPatch !== undefined) {
      const patch = validateAndParsePatch(
        options.initialPatch.patch,
        options.documentPath,
      );
      const proposed = applyPatch(referenceText, patch, {
        autoConvertLineEndings: true,
        fuzzFactor: 0,
      });
      if (proposed === false) {
        throw new Error(
          "review-diff initial patch does not apply to the baseline",
        );
      }
      const proposedText = normalizeText(proposed);
      if (proposedText === referenceText) {
        throw new Error(
          "review-diff patch does not change the target document",
        );
      }
      workingText = proposedText;
      const packetId = randomUUID();
      const reviewId = options.reviewId ?? randomUUID();
      initialPacketId = packetId;
      initialReviewId = reviewId;
      packets = [
        {
          packetId,
          reviewId,
          clientRequestId: options.initialPatch.clientRequestId ?? randomUUID(),
          description: options.initialPatch.description,
          appliedAt: new Date().toISOString(),
          patchFormat: options.initialPatch.patchFormat,
          patch: options.initialPatch.patch,
          applicationGeneration: 1,
        },
      ];
      generation = 1;
    }

    const reviewId = initialReviewId ?? options.reviewId ?? randomUUID();
    const state: ActiveReviewState = {
      reviewId,
      documentId: options.documentId,
      documentPath: options.documentPath,
      baselineText: referenceText,
      referenceText,
      generation,
      packets,
      diskFenceSha256: options.diskBaselineSha256,
      invalidated: false,
    };
    this.reviews.set(options.documentId, state);
    if (initialPacketId !== undefined) {
      this.packetIndex.set(initialPacketId, reviewId);
    }

    this.emitEvent("review.started", {
      reviewId,
      documentId: options.documentId,
    });
    return { state, workingText };
  }

  /**
   * Submit a proposal packet against an active review. The patch applies to
   * the LIVE document text; the returned working text is what the caller must
   * now apply to the document. referenceText is unchanged; existing
   * unresolved chunks remain.
   */
  submitPacket(
    documentId: string,
    options: SubmitPacketOptions,
  ): SubmitPacketResult | SubmitPacketError {
    // Idempotency: return the original result for a repeated clientRequestId
    const existing = this.idempotencyIndex.get(
      this.idempotencyIndexKey(documentId, options.clientRequestId),
    );
    if (existing !== undefined) {
      return existing;
    }

    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "No active review for this document.",
      };
    }

    if (this.isInvalidated(review)) {
      return {
        ok: false,
        code: "REVIEW_INVALIDATED",
        message: "The review was invalidated by external disk drift.",
      };
    }

    if (
      options.expectedReviewGeneration !== undefined &&
      options.expectedReviewGeneration !== review.generation
    ) {
      return {
        ok: false,
        code: "REVISION_MISMATCH",
        message: `Expected review generation ${options.expectedReviewGeneration} but current is ${review.generation}.`,
      };
    }

    let patch: StructuredPatch;
    try {
      patch = validateAndParsePatch(options.patch, review.documentPath);
    } catch (err) {
      return {
        ok: false,
        code: "PATCH_INVALID",
        message: err instanceof Error ? err.message : "Invalid patch.",
      };
    }

    const workingText = this.workingTextOf(documentId);
    const proposed = applyPatch(workingText, patch, {
      autoConvertLineEndings: true,
      fuzzFactor: 0,
    });
    if (proposed === false) {
      return {
        ok: false,
        code: "PATCH_NOT_APPLICABLE",
        message:
          "The patch does not apply with zero fuzz to the current working text.",
      };
    }

    const newWorkingText = normalizeText(proposed);
    // openReview rejects an initial patch that leaves the text unchanged; a
    // later packet has to answer to the same invariant. A no-op that is allowed
    // through still burns a generation and becomes the newest packet, which
    // blocks retraction of the real one underneath it.
    if (newWorkingText === workingText) {
      return {
        ok: false,
        code: "PATCH_INVALID",
        message: "The patch does not change the target document.",
      };
    }
    const packetId = randomUUID();
    review.packets.push({
      packetId,
      reviewId: review.reviewId,
      clientRequestId: options.clientRequestId,
      description: options.description,
      appliedAt: new Date().toISOString(),
      patchFormat: options.patchFormat,
      patch: options.patch,
      applicationGeneration: review.generation + 1,
    });
    review.generation += 1;
    this.packetIndex.set(packetId, review.reviewId);

    // Count against the text the document is ABOUT to show, not the resolver:
    // the caller has not applied newWorkingText yet.
    const unresolvedChunks = computeReviewChunks(
      review.referenceText,
      newWorkingText,
    ).length;
    const result: SubmitPacketResult = {
      ok: true,
      packetId,
      reviewId: review.reviewId,
      generation: review.generation,
      workingText: newWorkingText,
      unresolvedChunks,
      state: unresolvedChunks === 0 ? "resolved-awaiting-save" : "active",
    };
    this.idempotencyIndex.set(
      this.idempotencyIndexKey(documentId, options.clientRequestId),
      result,
    );

    this.emitEvent("proposal.applied", {
      reviewId: review.reviewId,
      documentId,
      packetId,
      generation: review.generation,
      unresolvedChunks,
    });
    return result;
  }

  /**
   * Decide a single chunk by its content-addressed id.
   *
   * Accept makes the reference agree with the working text on the chunk (the
   * document does not change). Reject computes the working text with the
   * chunk restored to the reference; applying that text to the document is
   * the caller's obligation. A stale id — the region changed since the caller
   * read it — fails loudly with CHUNK_NOT_FOUND rather than splicing at a
   * position that no longer means what the caller thought.
   */
  decideChunk(
    documentId: string,
    reviewId: string,
    chunkId: string,
    decision: "accept" | "reject",
  ): ChunkDecisionResult | SubmitPacketError {
    const review = this.reviews.get(documentId);
    if (review === undefined || review.reviewId !== reviewId) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "No active review for this document.",
      };
    }
    if (this.isInvalidated(review)) {
      return {
        ok: false,
        code: "REVIEW_INVALIDATED",
        message: "The review was invalidated by external disk drift.",
      };
    }
    const workingText = this.workingTextOf(documentId);
    const partition = computeReviewChunks(review.referenceText, workingText);
    const chunk = partition.find((c) => c.chunkId === chunkId);
    if (chunk === undefined) {
      return {
        ok: false,
        code: "CHUNK_NOT_FOUND",
        message: `No unresolved chunk ${chunkId} exists at review generation ${review.generation}.`,
      };
    }

    let newWorkingText: string | undefined;
    let unresolvedChunks: number;
    if (decision === "accept") {
      review.referenceText = spliceChunk(review.referenceText, chunk, "accept");
      unresolvedChunks = computeReviewChunks(
        review.referenceText,
        workingText,
      ).length;
    } else {
      newWorkingText = spliceChunk(workingText, chunk, "reject");
      unresolvedChunks = computeReviewChunks(
        review.referenceText,
        newWorkingText,
      ).length;
    }
    review.generation += 1;

    this.emitEvent("review.changed", {
      reviewId: review.reviewId,
      documentId,
      generation: review.generation,
      unresolvedChunks,
    });
    if (unresolvedChunks === 0) {
      this.emitEvent("review.resolved", {
        reviewId: review.reviewId,
        documentId,
        generation: review.generation,
        unresolvedChunks: 0,
      });
    }
    return {
      ok: true,
      reviewId: review.reviewId,
      documentId,
      chunkId,
      decision,
      generation: review.generation,
      workingText: newWorkingText,
      unresolvedChunks,
      state: unresolvedChunks === 0 ? "resolved-awaiting-save" : "active",
    };
  }

  /**
   * Clear all unresolved suggestions: the working text becomes the reference.
   * Preserves accepted changes; discards only currently unresolved material.
   * Applying the returned working text to the document is the caller's
   * obligation.
   */
  clearUnresolved(
    documentId: string,
  ): ClearUnresolvedResult | SubmitPacketError {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "No active review for this document.",
      };
    }
    review.generation += 1;
    this.emitEvent("review.cleared", {
      reviewId: review.reviewId,
      documentId,
      unresolvedChunks: 0,
    });
    return {
      ok: true,
      reviewId: review.reviewId,
      documentId,
      workingText: review.referenceText,
      referenceText: review.referenceText,
      generation: review.generation,
      unresolvedChunks: 0,
      state: "cleared",
    };
  }

  /**
   * Retract a proposal packet. Conservative: only the newest packet, no
   * subsequent packets or user decisions touching its ranges, and its
   * inverse applies exactly. Applying the returned working text to the
   * document is the caller's obligation.
   */
  retractPacket(packetId: string): RetractPacketResult | RetractPacketError {
    const reviewId = this.packetIndex.get(packetId);
    if (reviewId === undefined) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message: "The packet was not found.",
        reviewId: "",
        canClearUnresolved: true,
      };
    }
    // Find the review
    let review: ActiveReviewState | undefined;
    for (const r of this.reviews.values()) {
      if (r.reviewId === reviewId) {
        review = r;
        break;
      }
    }
    if (review === undefined) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message: "The review for this packet is no longer active.",
        reviewId,
        canClearUnresolved: true,
      };
    }

    const packetIndex = review.packets.findIndex(
      (p) => p.packetId === packetId,
    );
    if (packetIndex === -1) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message: "The packet was not found in its review.",
        reviewId: review.reviewId,
        canClearUnresolved: true,
      };
    }

    // Must be the newest active packet
    if (packetIndex !== review.packets.length - 1) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message: "A later packet has been applied after this one.",
        reviewId: review.reviewId,
        canClearUnresolved: true,
      };
    }

    if (review.packets[packetIndex].applicationGeneration !== review.generation) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message: "A review decision was recorded after this proposal was applied.",
        reviewId: review.reviewId,
        canClearUnresolved: true,
      };
    }

    // Compute the inverse patch and verify it applies exactly
    const workingText = this.workingTextOf(review.documentId);
    const inversePatch = invertPatch(review.packets[packetIndex].patch);
    const reverted = applyPatch(workingText, inversePatch, {
      autoConvertLineEndings: true,
      fuzzFactor: 0,
    });
    if (reverted === false) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message:
          "The proposal has been modified or overlapped by later review activity.",
        reviewId: review.reviewId,
        canClearUnresolved: true,
      };
    }

    const newWorkingText = normalizeText(reverted);
    review.packets.pop();
    this.packetIndex.delete(packetId);
    review.generation += 1;

    const unresolvedChunks = computeReviewChunks(
      review.referenceText,
      newWorkingText,
    ).length;
    this.emitEvent("proposal.retracted", {
      reviewId: review.reviewId,
      documentId: review.documentId,
      packetId,
      generation: review.generation,
      unresolvedChunks,
    });
    return {
      ok: true,
      packetId,
      reviewId: review.reviewId,
      documentId: review.documentId,
      generation: review.generation,
      workingText: newWorkingText,
      unresolvedChunks,
    };
  }

  /**
   * Mark a review invalidated by external disk drift. Rejects further packets;
   * preserves both live editor content and external disk content.
   */
  invalidateReview(documentId: string): void {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return;
    }
    review.invalidated = true;
    this.emitEvent("review.invalidated", {
      reviewId: review.reviewId,
      documentId,
    });
  }

  /**
   * Complete the review after a successful save. Removes it from the store.
   */
  completeReview(documentId: string): void {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return;
    }
    this.emitEvent("review.completed", {
      reviewId: review.reviewId,
      documentId,
    });
    for (const p of review.packets) {
      this.packetIndex.delete(p.packetId);
      this.idempotencyIndex.delete(this.idempotencyIndexKey(documentId, p.clientRequestId));
    }
    this.reviews.delete(documentId);
  }

  /**
   * Remove a review (document closed). Emits no event if not present.
   */
  closeReview(documentId: string): void {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return;
    }
    for (const p of review.packets) {
      this.packetIndex.delete(p.packetId);
      this.idempotencyIndex.delete(this.idempotencyIndexKey(documentId, p.clientRequestId));
    }
    this.reviews.delete(documentId);
  }

  /**
   * Get the active review state for a document.
   */
  getReview(documentId: string): ActiveReviewState | undefined {
    return this.reviews.get(documentId);
  }

  /**
   * Get the active review carrying a reviewId, however it is keyed.
   */
  findReviewByReviewId(reviewId: string): ActiveReviewState | undefined {
    for (const review of this.reviews.values()) {
      if (review.reviewId === reviewId) {
        return review;
      }
    }
    return undefined;
  }

  /**
   * The number of unresolved chunks for a document's active review, counted
   * by the one shared engine against the live document.
   */
  countUnresolved(documentId: string): number {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return 0;
    }
    return this.partitionOf(review).length;
  }

  /**
   * Get the review state for status reporting.
   */
  getReviewStatus(documentId: string):
    | {
        reviewId: string;
        state: ReviewState;
        generation: number;
        unresolvedChunks: number;
        packetCount: number;
      }
    | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    const unresolvedChunks = this.partitionOf(review).length;
    return {
      reviewId: review.reviewId,
      state: this.isInvalidated(review)
        ? "invalidated"
        : unresolvedChunks === 0
          ? "resolved-awaiting-save"
          : "active",
      generation: review.generation,
      unresolvedChunks,
      packetCount: review.packets.length,
    };
  }

  /**
   * Get all active reviews (for reviews/list).
   */
  listReviews(): Array<{
    reviewId: string;
    documentId: string;
    state: ReviewState;
    generation: number;
    unresolvedChunks: number;
    packetCount: number;
  }> {
    return [...this.reviews.values()].map((r) => {
      const unresolvedChunks = this.partitionOf(r).length;
      return {
        reviewId: r.reviewId,
        documentId: r.documentId,
        state: this.isInvalidated(r)
          ? "invalidated"
          : unresolvedChunks === 0
            ? "resolved-awaiting-save"
            : "active",
        generation: r.generation,
        unresolvedChunks,
        packetCount: r.packets.length,
      };
    });
  }

  /**
   * The current outstanding chunks — the shared partition dressed for the
   * agent API, with a focused zero-context patch per chunk.
   */
  getOutstandingChunks(documentId: string): OutstandingChunk[] | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    return this.partitionOf(review).map((chunk) => ({
      chunkId: chunk.chunkId,
      referenceRange: { fromLine: chunk.refFromLine, toLine: chunk.refToLine },
      workingRange: { fromLine: chunk.workFromLine, toLine: chunk.workToLine },
      referenceText: chunk.referenceText,
      workingText: chunk.workingText,
      patch: createPatch("document", chunk.referenceText, chunk.workingText, "", "", {
        context: 0,
      }),
    }));
  }

  /**
   * Compute the composite unresolved patch: referenceText → working text.
   */
  getReviewDiff(documentId: string): string | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    return createPatch(
      "document",
      review.referenceText,
      this.workingTextOf(documentId),
      "",
      "",
      { context: 3 },
    );
  }

  // ========================================================================
  // Internal helpers
  // ========================================================================

  isInvalidated(review: ActiveReviewState): boolean {
    return review.invalidated;
  }

  private idempotencyIndexKey(documentId: string, clientRequestId: string): string {
    return `${documentId}:${clientRequestId}`;
  }

  emitEvent(event: string, payload: Record<string, unknown>): void {
    const mapped: Record<string, unknown> = { ...payload };
    if ("generation" in mapped) {
      mapped.reviewGeneration = mapped.generation;
      delete mapped.generation;
    }
    const documentId = typeof mapped.documentId === "string" ? mapped.documentId : undefined;
    if (documentId !== undefined) {
      const review = this.reviews.get(documentId);
      if (review !== undefined) {
        if (!("reviewGeneration" in mapped)) {
          mapped.reviewGeneration = review.generation;
        }
        if (!("unresolvedChunks" in mapped)) {
          mapped.unresolvedChunks = this.partitionOf(review).length;
        }
      }
    }
    const agentEvent: AgentEvent = {
      event: event as AgentEvent["event"],
      timestamp: new Date().toISOString(),
      ...mapped,
    };
    this.emit(event, agentEvent);
    this.emit("*", agentEvent);
  }
}

// ============================================================================
// Patch inversion helper
// ============================================================================

function invertPatch(patchText: string): string {
  const patches = parsePatch(patchText);
  if (patches.length !== 1) {
    throw new Error("Cannot invert a multi-file patch");
  }
  const reversed = reversePatch(patches);
  // Re-serialize the single reversed patch
  return formatPatch(reversed[0]);
}

function formatPatch(patch: StructuredPatch): string {
  const lines: string[] = [];
  lines.push(`--- ${patch.oldFileName ?? "document"}`);
  lines.push(`+++ ${patch.newFileName ?? "document"}`);
  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }
  return lines.join("\n") + "\n";
}
