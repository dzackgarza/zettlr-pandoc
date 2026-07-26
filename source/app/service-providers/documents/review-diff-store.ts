/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiffStore
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Provider-owned authoritative review state. One active
 *                  review per document, keyed by documentId (not path).
 *
 *                  This is the critical prerequisite identified in the agent
 *                  API spec: the evolving merge reference must be owned by
 *                  the provider, not by individual CodeMirror panes. Without
 *                  provider-owned referenceText, live packet composition,
 *                  pane synchronization, remounting, and reliable
 *                  unresolved-status reporting are unsound.
 *
 *                  State model:
 *                    referenceText = accepted state + rejected restorations
 *                    workingText   = current visible provider document
 *                    unresolved    = diff(referenceText, workingText)
 *
 *                  Transitions:
 *                    incoming proposal → workingText := applyPatch(workingText)
 *                    accept chunk      → referenceText agrees with workingText
 *                    reject chunk      → workingText agrees with referenceText
 *
 * END HEADER
 */

import { createHash, randomUUID } from "crypto";
import EventEmitter from "events";
import {
  applyPatch,
  parsePatch,
  reversePatch,
  diffLines,
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

// ============================================================================
// Types
// ============================================================================

export interface ReviewDiffStoreSnapshot {
  documentId: string;
  referenceText: string;
  workingText: string;
  generation: number;
  packets: ProposalPacket[];
  diskFenceSha256: string;
}

export interface OpenReviewOptions {
  documentId: string;
  documentPath: string;
  baselineText: string;
  diskBaselineSha256: string;
  /** Optional: initial patch to apply (first proposal packet) */
  initialPatch?: {
    patchFormat: "unified-diff";
    patch: string;
    description?: string;
    clientRequestId?: string;
  };
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
    | "REVISION_MISMATCH";
  message: string;
}

export interface ClearUnresolvedResult {
  ok: true;
  reviewId: string;
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
  generation: number;
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
  generation: number;
  referenceText: string;
  workingText: string;
  unresolvedChunks: number;
}

// ============================================================================
// Helpers
// ============================================================================

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeText(content: string): string {
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
  // Per spec §6.3: headers must be either the exact canonical document URI or
  // the generic "--- document" / "+++ document". Basename matching is too weak.
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
  // Exact canonical path
  const stripped = normalized.replace(/^(a|b)\//, "");
  if (!path.isAbsolute(stripped)) {
    return false;
  }
  return path.resolve(stripped) === path.resolve(documentPath);
}

// ============================================================================
// ReviewDiffStore
// ============================================================================

/**
 * Provider-owned authoritative review state. The main process owns all
 * agent-visible state; this store is the single source of truth for the
 * evolving merge reference.
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
   * Open a new review session for a document. Returns the new review state.
   * Throws if a review is already active for this documentId.
   */
  openReview(options: OpenReviewOptions): ActiveReviewState {
    if (this.reviews.has(options.documentId)) {
      throw new Error(
        `A review is already active for document ${options.documentId}`,
      );
    }

    const baselineText = normalizeText(options.baselineText);

    let referenceText = baselineText;
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
      const reviewId = randomUUID();
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
        },
      ];
      generation = 1;
    }

    const reviewId = initialReviewId ?? randomUUID();
    const state: ActiveReviewState = {
      reviewId,
      documentId: options.documentId,
      documentPath: options.documentPath,
      referenceText,
      workingText,
      generation,
      packets,
      diskFenceSha256: options.diskBaselineSha256,
    };
    this.reviews.set(options.documentId, state);
    if (initialPacketId !== undefined) {
      this.packetIndex.set(initialPacketId, reviewId);
    }

    this.emitEvent("review.started", {
      reviewId,
      documentId: options.documentId,
    });
    return state;
  }

  /**
   * Submit a proposal packet against an active review. Applies to workingText
   * only; referenceText is unchanged. Existing unresolved chunks remain.
   */
  submitPacket(
    documentId: string,
    options: SubmitPacketOptions,
  ): SubmitPacketResult | SubmitPacketError {
    // Idempotency: return the original result for a repeated clientRequestId
    const existing = this.idempotencyIndex.get(options.clientRequestId);
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

    const proposed = applyPatch(review.workingText, patch, {
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
    const packetId = randomUUID();
    review.packets.push({
      packetId,
      reviewId: review.reviewId,
      clientRequestId: options.clientRequestId,
      description: options.description,
      appliedAt: new Date().toISOString(),
      patchFormat: options.patchFormat,
      patch: options.patch,
    });
    review.workingText = newWorkingText;
    review.generation += 1;
    this.packetIndex.set(packetId, review.reviewId);

    const unresolvedChunks = this.countUnresolvedChunks(review);
    const result: SubmitPacketResult = {
      ok: true,
      packetId,
      reviewId: review.reviewId,
      generation: review.generation,
      workingText: newWorkingText,
      unresolvedChunks,
      state: unresolvedChunks === 0 ? "resolved-awaiting-save" : "active",
    };
    this.idempotencyIndex.set(options.clientRequestId, result);

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
   * Report a user accept decision for a chunk range. Updates referenceText to
   * agree with workingText on that range. Increments generation.
   *
   * The renderer computes exact from/to offsets; the store applies them.
   */
  applyChunkAccept(
    documentId: string,
    reviewId: string,
    fromOffset: number,
    toOffset: number,
    expectedGeneration: number,
  ): ChunkDecisionResult | SubmitPacketError {
    const review = this.reviews.get(documentId);
    if (review === undefined || review.reviewId !== reviewId) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "No active review for this document.",
      };
    }
    if (review.generation !== expectedGeneration) {
      return {
        ok: false,
        code: "REVISION_MISMATCH",
        message: `Expected review generation ${expectedGeneration} but current is ${review.generation}.`,
      };
    }
    // Accept: referenceText agrees with workingText on [fromOffset, toOffset)
    const workingSlice = review.workingText.slice(fromOffset, toOffset);
    review.referenceText =
      review.referenceText.slice(0, fromOffset) +
      workingSlice +
      review.referenceText.slice(toOffset);
    review.generation += 1;
    const unresolvedChunks = this.countUnresolvedChunks(review);
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
      });
    }
    return {
      ok: true,
      reviewId: review.reviewId,
      generation: review.generation,
      referenceText: review.referenceText,
      workingText: review.workingText,
      unresolvedChunks,
    };
  }

  /**
   * Report a user reject decision for a chunk range. Updates workingText to
   * agree with referenceText on that range. Increments generation.
   */
  applyChunkReject(
    documentId: string,
    reviewId: string,
    fromOffset: number,
    toOffset: number,
    expectedGeneration: number,
  ): ChunkDecisionResult | SubmitPacketError {
    const review = this.reviews.get(documentId);
    if (review === undefined || review.reviewId !== reviewId) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "No active review for this document.",
      };
    }
    if (review.generation !== expectedGeneration) {
      return {
        ok: false,
        code: "REVISION_MISMATCH",
        message: `Expected review generation ${expectedGeneration} but current is ${review.generation}.`,
      };
    }
    // Reject: workingText agrees with referenceText on [fromOffset, toOffset)
    const referenceSlice = review.referenceText.slice(fromOffset, toOffset);
    review.workingText =
      review.workingText.slice(0, fromOffset) +
      referenceSlice +
      review.workingText.slice(toOffset);
    review.generation += 1;
    const unresolvedChunks = this.countUnresolvedChunks(review);
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
      });
    }
    return {
      ok: true,
      reviewId: review.reviewId,
      generation: review.generation,
      referenceText: review.referenceText,
      workingText: review.workingText,
      unresolvedChunks,
    };
  }

  /**
   * Clear all unresolved suggestions. workingText := referenceText.
   * Preserves accepted changes; discards only currently unresolved material.
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
    review.workingText = review.referenceText;
    review.generation += 1;
    this.emitEvent("review.cleared", { reviewId: review.reviewId, documentId });
    return {
      ok: true,
      reviewId: review.reviewId,
      workingText: review.workingText,
      referenceText: review.referenceText,
      generation: review.generation,
      unresolvedChunks: 0,
      state: "cleared",
    };
  }

  /**
   * Retract a proposal packet. Conservative: only the newest packet, no
   * subsequent packets or user decisions touching its ranges, and its
   * inverse applies exactly.
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

    // Compute the inverse patch and verify it applies exactly
    const inversePatch = invertPatch(review.packets[packetIndex].patch);
    const reverted = applyPatch(review.workingText, inversePatch, {
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

    review.workingText = normalizeText(reverted);
    review.packets.pop();
    this.packetIndex.delete(packetId);
    review.generation += 1;

    const unresolvedChunks = this.countUnresolvedChunks(review);
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
      generation: review.generation,
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
    this.emitEvent("review.invalidated", {
      reviewId: review.reviewId,
      documentId,
    });
    // Keep the state in the map so status queries can report 'invalidated'
    // but mark it. We store this by emitting the event; the DocumentManager
    // will remove the review and trigger external-change resolution.
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
      this.idempotencyIndex.delete(p.clientRequestId);
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
      this.idempotencyIndex.delete(p.clientRequestId);
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
    return {
      reviewId: review.reviewId,
      state: this.isInvalidated(review)
        ? "invalidated"
        : this.countUnresolvedChunks(review) === 0
          ? "resolved-awaiting-save"
          : "active",
      generation: review.generation,
      unresolvedChunks: this.countUnresolvedChunks(review),
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
    return [...this.reviews.values()].map((r) => ({
      reviewId: r.reviewId,
      documentId: r.documentId,
      state:
        this.countUnresolvedChunks(r) === 0
          ? "resolved-awaiting-save"
          : "active",
      generation: r.generation,
      unresolvedChunks: this.countUnresolvedChunks(r),
      packetCount: r.packets.length,
    }));
  }

  /**
   * Compute the current outstanding chunks: diff(referenceText, workingText).
   * Chunk IDs are ephemeral, valid only for the reported generation.
   */
  getOutstandingChunks(documentId: string): OutstandingChunk[] | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    // Use the diff library to compute structured chunks
    const parts = diffLines(review.referenceText, review.workingText);
    const chunks: OutstandingChunk[] = [];
    let refLine = 1;
    let workLine = 1;
    let chunkIndex = 0;
    for (const part of parts) {
      const lineCount = part.count ?? 0;
      if (part.added || part.removed) {
        // Coalesce adjacent added+removed into a single chunk
        const referenceRange = part.removed
          ? { fromLine: refLine, toLine: refLine + lineCount - 1 }
          : { fromLine: refLine, toLine: refLine - 1 };
        const workingRange = part.added
          ? { fromLine: workLine, toLine: workLine + lineCount - 1 }
          : { fromLine: workLine, toLine: workLine - 1 };
        chunks.push({
          chunkId: `chunk-${review.generation}-${chunkIndex++}`,
          generation: review.generation,
          referenceRange,
          workingRange,
          patch: "",
        });
      }
      if (!part.added) {
        refLine += lineCount;
      }
      if (!part.removed) {
        workLine += lineCount;
      }
    }
    return chunks;
  }

  /**
   * Compute the composite unresolved patch: referenceText → workingText.
   */
  getReviewDiff(documentId: string): string | undefined {
    const review = this.reviews.get(documentId);
    if (review === undefined) {
      return undefined;
    }
    return createPatch(
      "document",
      review.referenceText,
      review.workingText,
      "",
      "",
      { context: 3 },
    );
  }

  // ========================================================================
  // Internal helpers
  // ========================================================================

  private countUnresolvedChunks(review: ActiveReviewState): number {
    if (review.referenceText === review.workingText) {
      return 0;
    }
    const parts = diffLines(review.referenceText, review.workingText);
    let count = 0;
    let i = 0;
    while (i < parts.length) {
      if (parts[i].added || parts[i].removed) {
        count += 1;
        // Coalesce adjacent added+removed
        while (
          i + 1 < parts.length &&
          (parts[i + 1].added || parts[i + 1].removed)
        ) {
          i += 1;
        }
      }
      i += 1;
    }
    return count;
  }

  private isInvalidated(_review: ActiveReviewState): boolean {
    // For the initial implementation, invalidated reviews are removed from
    // the store by the DocumentManager when it detects external drift.
    // If present in the map, it is active or resolved-awaiting-save.
    return false;
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    const agentEvent: AgentEvent = {
      event: event as AgentEvent["event"],
      timestamp: new Date().toISOString(),
      ...payload,
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
