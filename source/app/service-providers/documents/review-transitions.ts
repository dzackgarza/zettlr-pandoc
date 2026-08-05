/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pure review transitions
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Every rule of the review state machine, as functions from
 *                  (committed review, working text, request) to a candidate
 *                  review, a candidate working text, a response, and the
 *                  events the commit owes its audiences.
 *
 *                  Nothing here reads a file, reaches for DocumentManager,
 *                  emits an event, broadcasts IPC, or touches the review it
 *                  was handed: every function clones first and validates
 *                  completely before it returns a plan. A caller that never
 *                  commits the plan therefore leaves no trace — which is what
 *                  makes "a refused proposal leaves no residue" a property of
 *                  the code rather than of the order its cleanup runs in.
 *
 *                  Applying a plan is the caller's whole obligation:
 *                    persist  → replace the review → apply the working text
 *                    → emit the events → answer with the response.
 *
 * END HEADER
 */

import { randomUUID } from "crypto";
import {
  applyPatch,
  parsePatch,
  reversePatch,
  type StructuredPatch,
} from "diff";
import path from "path";
import type {
  AcceptAllChunksResponse,
  ChunkDecision,
  ChunkDecisionResponse,
  DocumentRevision,
  ReviewComment,
  ReviewState,
  SubmitProposalResponse,
} from "@dts/common/agent-api";
import type {
  ActiveReviewState,
  ChunkHold,
  ReviewPacket,
} from "@dts/common/review-domain";
import {
  computeReviewChunks,
  spliceChunk,
  type RefSpan,
  type ReviewChunk,
} from "@common/modules/review/review-chunks";
import {
  classifyReviewState,
  countPending,
  normalizeText,
} from "./review-diff-store";
import { sha256Text } from "@common/util/sha256";

// ============================================================================
// Plan and error shapes
// ============================================================================

/**
 * One event a committed plan owes its audiences, before the emitter fills in
 * whatever the payload left implicit. Drafted here and emitted by the caller:
 * a plan that is never committed must announce nothing.
 */
export interface AgentEventDraft {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * The complete candidate outcome of one review mutation. `nextReview` is
 * undefined when the transition ends the review. `nextWorkingText` is what
 * the document must show afterwards — equal to the current text for a
 * transition that moves no document bytes.
 */
export interface ReviewMutationPlan<Response> {
  nextReview: ActiveReviewState | undefined;
  nextWorkingText: string;
  response: Response;
  events: AgentEventDraft[];
}

export interface ReviewTransitionError {
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

export interface RetractionError {
  ok: false;
  code: "PACKET_NOT_RETRACTABLE";
  message: string;
  reviewId: string;
  canClearUnresolved: true;
}

/** A plan and an error are told apart by the discriminant only errors carry. */
export function isTransitionError<Response, Error extends { ok: false }>(
  result: ReviewMutationPlan<Response> | Error,
): result is Error {
  return "ok" in result;
}

// ============================================================================
// Request and response shapes owned here
// ============================================================================

/** One ordered claim of a proposal: prose plus the patch implementing it. */
export interface ClaimInput {
  patch: string;
  description: string;
}

export interface ClearReviewResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  state: ReviewState;
  documentRevision: DocumentRevision;
  reviewGeneration: number;
  unresolvedChunks: number;
}

export interface AddReviewCommentResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  reviewGeneration: number;
  comment: ReviewComment;
}

export interface RetractProposalResponse {
  ok: true;
  retracted: true;
  packetId: string;
  reviewId: string;
  documentId: string;
  reviewGeneration: number;
  unresolvedChunks: number;
  documentRevision: DocumentRevision;
}

// ============================================================================
// Cloning
// ============================================================================

/**
 * A deep-enough copy: every container a transition may append to or rewrite
 * is fresh, so mutating the clone cannot reach the committed review. The
 * leaves are strings and numbers, which are copied by assignment anyway.
 */
function cloneReview(review: ActiveReviewState): ActiveReviewState {
  return {
    ...review,
    packets: review.packets.map((packet) => ({
      ...packet,
      refSpans: packet.refSpans.map((span) => ({ ...span })),
    })),
    submissions: review.submissions.map((submission) => ({
      ...submission,
      packetIds: [...submission.packetIds],
      response: { ...submission.response },
    })),
    holds: review.holds.map((hold) => ({ ...hold })),
    comments: review.comments.map((comment) => ({ ...comment })),
  };
}

// ============================================================================
// Patch validation and application
// ============================================================================

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

/** One validated, applied claim: its inputs plus the text it produced. */
interface AppliedClaimStep {
  patch: string;
  description: string;
  textAfter: string;
}

/**
 * Validate and apply an ordered claim sequence against startText.
 * All-or-nothing: the first claim that fails invalidates the whole sequence.
 * Claim k applies with zero fuzz to the text claim k-1 produced and must
 * change it; error messages name the failing claim by its 1-based position.
 */
export function applyClaimSequence(
  startText: string,
  documentPath: string,
  claims: readonly ClaimInput[],
): { ok: true; steps: AppliedClaimStep[] } | ReviewTransitionError {
  if (claims.length === 0) {
    throw new Error("applyClaimSequence requires at least one claim");
  }
  const steps: AppliedClaimStep[] = [];
  let text = startText;
  for (let i = 0; i < claims.length; i++) {
    const label = claims.length === 1 ? "The patch" : `Claim ${i + 1}'s patch`;
    let patch: StructuredPatch;
    try {
      patch = validateAndParsePatch(claims[i].patch, documentPath);
    } catch (err) {
      return {
        ok: false,
        code: "PATCH_INVALID",
        message: `${label} is invalid: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const applied = applyPatch(text, patch, {
      autoConvertLineEndings: true,
      fuzzFactor: 0,
    });
    if (applied === false) {
      return {
        ok: false,
        code: "PATCH_NOT_APPLICABLE",
        message:
          `${label} does not apply with zero fuzz to ` +
          (i === 0 ? "the current working text." : `the text claim ${i} produced.`),
      };
    }
    const textAfter = normalizeText(applied);
    // A no-op that is allowed through still burns a generation and becomes
    // the newest packet, which blocks retraction of the real one underneath.
    if (textAfter === text) {
      return {
        ok: false,
        code: "PATCH_INVALID",
        message: `${label} does not change the target document.`,
      };
    }
    steps.push({
      patch: claims[i].patch,
      description: claims[i].description,
      textAfter,
    });
    text = textAfter;
  }
  return { ok: true, steps };
}

function invertPatch(patchText: string): string {
  const patches = parsePatch(patchText);
  if (patches.length !== 1) {
    throw new Error("Cannot invert a multi-file patch");
  }
  return formatPatch(reversePatch(patches)[0]);
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

// ============================================================================
// Reference-span attribution
// ============================================================================

/**
 * The reference-side footprint of one applied claim: the merge-reference
 * spans the working-text transition before → after changed, at chunk
 * granularity.
 *
 * Reference coordinates are the durable frame for attribution: user edits
 * move working-side positions freely and never pass through a transition,
 * but the reference moves only on decisions, which do — so spans recorded
 * here stay meaningful for as long as they are remapped across decisions.
 *
 * Both diffs run through the one shared engine: the claim's own edits are
 * the partition of before → after, and each edited span is projected onto
 * the reference through the partition of reference → after. A span reaching
 * into a disagreement chunk widens to that chunk's whole reference range —
 * attribution is consumed at chunk granularity, so a finer projection would
 * claim precision no consumer sees.
 */
function computeChangedRefSpans(
  referenceText: string,
  beforeText: string,
  afterText: string,
): RefSpan[] {
  const edits = computeReviewChunks(beforeText, afterText);
  if (edits.length === 0) {
    return [];
  }
  const partition = computeReviewChunks(referenceText, afterText);
  return mergeRefSpans(
    edits.map((edit) =>
      projectWorkingSpan(partition, edit.workFromLine, edit.workToLine),
    ),
  );
}

/**
 * Project one working-side line span onto the reference through a
 * (reference, working) partition. Boundaries in agreement regions map by the
 * accumulated line offset; a boundary inside a chunk rounds outward to the
 * chunk's reference range. An empty span — a pure deletion at a boundary —
 * maps to the reference range of the chunk covering that boundary, or to an
 * empty span at the projected point when the reference agrees there (the
 * deleted lines were a previous claim's own insertion, so the reference
 * holds nothing to attribute).
 */
function projectWorkingSpan(
  partition: readonly ReviewChunk[],
  from: number,
  to: number,
): RefSpan {
  if (from === to) {
    const covering = partition.find(
      (chunk) => chunk.workFromLine <= from && from <= chunk.workToLine,
    );
    if (covering !== undefined) {
      return { from: covering.refFromLine, to: covering.refToLine };
    }
    let offset = 0;
    for (const chunk of partition) {
      if (chunk.workToLine >= from) {
        break;
      }
      offset +=
        chunk.refToLine - chunk.refFromLine - (chunk.workToLine - chunk.workFromLine);
    }
    return { from: from + offset, to: from + offset };
  }
  let refFrom = -1;
  let offset = 0;
  for (const chunk of partition) {
    if (from < chunk.workFromLine) {
      break;
    }
    if (from < chunk.workToLine) {
      refFrom = chunk.refFromLine;
      break;
    }
    offset +=
      chunk.refToLine - chunk.refFromLine - (chunk.workToLine - chunk.workFromLine);
  }
  if (refFrom === -1) {
    refFrom = from + offset;
  }
  let refTo = -1;
  offset = 0;
  for (const chunk of partition) {
    if (to <= chunk.workFromLine) {
      break;
    }
    if (to <= chunk.workToLine) {
      refTo = chunk.refToLine;
      break;
    }
    offset +=
      chunk.refToLine - chunk.refFromLine - (chunk.workToLine - chunk.workFromLine);
  }
  if (refTo === -1) {
    refTo = to + offset;
  }
  return { from: refFrom, to: refTo };
}

/** Sort spans and merge every overlapping or touching pair. */
function mergeRefSpans(spans: readonly RefSpan[]): RefSpan[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: RefSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Remap a span list across a decided chunk covering reference lines
 * [refFrom, refTo). The decided region is resolved: span material inside it
 * is dropped rather than carried forward — a later edit of those lines is
 * the editor's change, not the packet's — and boundary points count as
 * inside because the same closed rule attributed them to the chunk
 * (chunkAttributesTo). Material behind the region shifts by lineDelta: the
 * line-count change an accept spliced into the reference, 0 for a reject.
 */
function remapSpans(
  spans: readonly RefSpan[],
  refFrom: number,
  refTo: number,
  lineDelta: number,
): RefSpan[] {
  const result: RefSpan[] = [];
  for (const span of spans) {
    if (span.from === span.to) {
      if (span.from < refFrom) {
        result.push({ ...span });
      } else if (span.from > refTo) {
        result.push({ from: span.from + lineDelta, to: span.to + lineDelta });
      }
      continue;
    }
    if (span.from < refFrom) {
      result.push({ from: span.from, to: Math.min(span.to, refFrom) });
    }
    if (span.to > refTo) {
      result.push({
        from: Math.max(span.from, refTo) + lineDelta,
        to: span.to + lineDelta,
      });
    }
  }
  return result;
}

/** Remap every packet's spans across one decided chunk (see remapSpans). */
function remapAcrossDecision(
  review: ActiveReviewState,
  chunk: ReviewChunk,
  lineDelta: number,
): void {
  for (const packet of review.packets) {
    packet.refSpans = remapSpans(
      packet.refSpans,
      chunk.refFromLine,
      chunk.refToLine,
      lineDelta,
    );
  }
}

// ============================================================================
// Hold reconciliation
// ============================================================================

/** Ignore only seam newlines when matching an unchanged held edit. */
function trimIdentitySeams(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
}

/**
 * Reconcile a clone's holds against a partition, and draft one
 * `review.commented` event per hold whose comment was orphaned.
 *
 * Chunk ids are content-addressed, so any change to a held chunk's text — a
 * user edit inside it, a later claim overlapping it, an explicit decision on
 * it — retires the id. A hold whose text is unchanged and merely moved is
 * reattached to the chunk that now carries it. One that cannot be placed is
 * released: a hold that carried a comment surfaces as an orphaned
 * review-level comment naming the vanished chunk, so the text is never
 * silently lost, and a textless one simply vanishes.
 */
function reconcileHolds(
  review: ActiveReviewState,
  partition: readonly ReviewChunk[],
): AgentEventDraft[] {
  const liveIds = new Set(partition.map((chunk) => chunk.chunkId));
  const usedIds = new Set<string>();
  const dangling: ChunkHold[] = [];
  for (const hold of review.holds) {
    if (liveIds.has(hold.chunkId)) {
      usedIds.add(hold.chunkId);
      continue;
    }
    const candidates = partition
      .filter((chunk) => !usedIds.has(chunk.chunkId))
      .filter((chunk) =>
        hold.referenceText !== undefined &&
        hold.workingText !== undefined &&
        trimIdentitySeams(chunk.referenceText) === trimIdentitySeams(hold.referenceText) &&
        trimIdentitySeams(chunk.workingText) === trimIdentitySeams(hold.workingText),
      )
      .map((chunk) => ({
        chunk,
        distance: (hold.referenceFromLine === undefined ? 0 : Math.abs(chunk.refFromLine - hold.referenceFromLine)) +
          (hold.workingFromLine === undefined ? 0 : Math.abs(chunk.workFromLine - hold.workingFromLine)),
      }))
      .sort((a, b) => a.distance - b.distance);
    const positionedCandidates = hold.referenceFromLine === undefined
      ? candidates
      : candidates.filter(({ chunk }) => chunk.refFromLine === hold.referenceFromLine);
    const selected = positionedCandidates.length === 1
      ? positionedCandidates[0]
      : positionedCandidates.length > 1 && positionedCandidates[0].distance < positionedCandidates[1].distance
        ? positionedCandidates[0]
        : undefined;
    if (selected !== undefined) {
      hold.chunkId = selected.chunk.chunkId;
      hold.referenceFromLine = selected.chunk.refFromLine;
      hold.workingFromLine = selected.chunk.workFromLine;
      usedIds.add(hold.chunkId);
    } else {
      dangling.push(hold);
    }
  }
  review.holds = review.holds.filter((hold) => usedIds.has(hold.chunkId));
  const unresolvedChunks = partition.length - review.holds.length;
  const events: AgentEventDraft[] = [];
  for (const hold of dangling) {
    if (hold.comment === undefined) {
      continue;
    }
    const comment: ReviewComment = {
      text: hold.comment,
      createdAt: new Date().toISOString(),
      orphanedFromChunkId: hold.chunkId,
    };
    review.comments.push(comment);
    // Orphaning is derived bookkeeping of an edit that already happened, not
    // a review decision, so it does not advance the generation cursor.
    events.push({
      event: "review.commented",
      payload: {
        reviewId: review.reviewId,
        documentId: review.documentId,
        comment: comment.text,
        orphanedFromChunkId: hold.chunkId,
        generation: review.generation,
        unresolvedChunks,
      },
    });
  }
  return events;
}

// ============================================================================
// Transitions
// ============================================================================

/**
 * Apply an ordered claim sequence, opening the review when none exists yet.
 * Opening here is what makes an all-or-nothing batch honest: a sequence that
 * does not apply produces no plan at all, so there is no empty review to
 * roll back and no `review.started` announcing one.
 *
 * The patches apply to the LIVE working text; the reference does not move,
 * so existing unresolved chunks survive untouched.
 */
export function prepareProposalSubmission(input: {
  review: ActiveReviewState | undefined;
  documentId: string;
  documentPath: string;
  workingText: string;
  diskSha256: string;
  claims: readonly ClaimInput[];
  clientRequestId: string;
  requestFingerprint: string;
}): ReviewMutationPlan<SubmitProposalResponse> | ReviewTransitionError {
  if (input.review !== undefined && input.review.invalidated) {
    return {
      ok: false,
      code: "REVIEW_INVALIDATED",
      message: "The review was invalidated by external disk drift.",
    };
  }
  const workingText = normalizeText(input.workingText);
  const opened = input.review === undefined;
  const next: ActiveReviewState =
    input.review === undefined
      ? {
          reviewId: randomUUID(),
          documentId: input.documentId,
          documentPath: input.documentPath,
          referenceText: workingText,
          generation: 0,
          packets: [],
          submissions: [],
          holds: [],
          comments: [],
          diskFenceSha256: input.diskSha256,
          invalidated: false,
        }
      : cloneReview(input.review);

  const sequence = applyClaimSequence(workingText, next.documentPath, input.claims);
  if (!sequence.ok) {
    return sequence;
  }

  const events: AgentEventDraft[] = [];
  if (opened) {
    events.push({
      event: "review.started",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        generation: 0,
        unresolvedChunks: 0,
      },
    });
  }

  const packetIds: string[] = [];
  let textBefore = workingText;
  for (const step of sequence.steps) {
    const packet: ReviewPacket = {
      packetId: randomUUID(),
      reviewId: next.reviewId,
      clientRequestId: input.clientRequestId,
      requestFingerprint: input.requestFingerprint,
      description: step.description,
      appliedAt: new Date().toISOString(),
      patch: step.patch,
      applicationGeneration: next.generation + 1,
      refSpans: computeChangedRefSpans(
        next.referenceText,
        textBefore,
        step.textAfter,
      ),
    };
    next.packets.push(packet);
    next.generation += 1;
    packetIds.push(packet.packetId);
    textBefore = step.textAfter;
  }

  const nextWorkingText = sequence.steps[sequence.steps.length - 1].textAfter;
  const partition = computeReviewChunks(next.referenceText, nextWorkingText);
  events.push(...reconcileHolds(next, partition));
  const unresolvedChunks = countPending(next, partition);

  const response: SubmitProposalResponse = {
    packetId: packetIds[packetIds.length - 1],
    packetIds,
    reviewId: next.reviewId,
    documentId: next.documentId,
    documentRevision: { sha256: sha256Text(nextWorkingText) },
    reviewGeneration: next.generation,
    unresolvedChunks,
    state: classifyReviewState(next.invalidated, unresolvedChunks),
  };
  // One event per packet, each carrying the state after the WHOLE sequence:
  // the intermediate texts never existed for any consumer.
  for (const packetId of packetIds) {
    events.push({
      event: "proposal.applied",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        packetId,
        generation: next.generation,
        unresolvedChunks,
      },
    });
  }
  // The ledger entry is appended here so it commits with the packets it
  // describes: a replay can only be answered by a state that also holds them.
  next.submissions.push({
    clientRequestId: input.clientRequestId,
    requestFingerprint: input.requestFingerprint,
    packetIds,
    response,
  });

  return { nextReview: next, nextWorkingText, response, events };
}

/**
 * Decide a single chunk by its content-addressed id — the ONE decision path
 * for all three verbs.
 *
 * Accept makes the reference agree with the working text on the chunk (the
 * document does not change). Reject computes the working text with the chunk
 * restored to the reference. Hold adjudicates nothing: it attaches an
 * optional comment and takes the chunk out of the pending count, so a
 * held-only review saves while the reference retains its disagreement.
 * Re-holding a held chunk replaces its comment. A stale id — the region
 * changed since the caller read it — fails with CHUNK_NOT_FOUND rather than
 * acting on a region that no longer means what the caller thought.
 */
export function prepareChunkDecision(input: {
  review: ActiveReviewState;
  workingText: string;
  chunkId: string;
  decision: ChunkDecision;
  comment?: string;
}): ReviewMutationPlan<ChunkDecisionResponse> | ReviewTransitionError {
  if (input.review.invalidated) {
    return {
      ok: false,
      code: "REVIEW_INVALIDATED",
      message: "The review was invalidated by external disk drift.",
    };
  }
  const workingText = normalizeText(input.workingText);
  const next = cloneReview(input.review);
  const partition = computeReviewChunks(next.referenceText, workingText);
  const events = reconcileHolds(next, partition);
  const chunk = partition.find((candidate) => candidate.chunkId === input.chunkId);
  if (chunk === undefined) {
    return {
      ok: false,
      code: "CHUNK_NOT_FOUND",
      message: `No unresolved chunk ${input.chunkId} exists at review generation ${next.generation}.`,
    };
  }

  let nextWorkingText = workingText;
  let unresolvedChunks: number;
  if (input.decision === "hold") {
    // Upsert: holding again replaces the comment (an empty re-hold clears it).
    next.holds = next.holds.filter((hold) => hold.chunkId !== input.chunkId);
    next.holds.push({
      chunkId: input.chunkId,
      comment: input.comment,
      heldAt: new Date().toISOString(),
      referenceText: chunk.referenceText,
      workingText: chunk.workingText,
      referenceFromLine: chunk.refFromLine,
      workingFromLine: chunk.workFromLine,
    });
    unresolvedChunks = partition.length - next.holds.length;
    next.generation += 1;
    events.push({
      event: "review.held",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        chunkId: input.chunkId,
        comment: input.comment,
        generation: next.generation,
        unresolvedChunks,
      },
    });
  } else {
    if (input.decision === "accept") {
      const referenceLineDelta =
        chunk.workToLine - chunk.workFromLine - (chunk.refToLine - chunk.refFromLine);
      for (const hold of next.holds) {
        if (hold.chunkId !== input.chunkId && hold.referenceFromLine !== undefined && hold.referenceFromLine >= chunk.refToLine) {
          hold.referenceFromLine += referenceLineDelta;
        }
      }
      next.referenceText = spliceChunk(next.referenceText, chunk, "accept");
      // The accepted splice changed the reference's line count: spans behind
      // it shift, spans on it are resolved and dropped.
      remapAcrossDecision(next, chunk, referenceLineDelta);
    } else {
      const workingLineDelta =
        chunk.refToLine - chunk.refFromLine - (chunk.workToLine - chunk.workFromLine);
      for (const hold of next.holds) {
        if (hold.chunkId !== input.chunkId && hold.workingFromLine !== undefined && hold.workingFromLine >= chunk.workToLine) {
          hold.workingFromLine += workingLineDelta;
        }
      }
      nextWorkingText = spliceChunk(workingText, chunk, "reject");
      // The reference did not move, but the chunk's reference region is now
      // resolved: attribution material there is dropped, so a later edit of
      // the same lines is the editor's change, not the packet's.
      remapAcrossDecision(next, chunk, 0);
    }
    const decided = computeReviewChunks(next.referenceText, nextWorkingText);
    events.push(...reconcileHolds(next, decided));
    unresolvedChunks = countPending(next, decided);
    next.generation += 1;
    events.push({
      event: "review.changed",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        generation: next.generation,
        unresolvedChunks,
      },
    });
  }

  if (unresolvedChunks === 0) {
    events.push({
      event: "review.resolved",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        generation: next.generation,
        unresolvedChunks: 0,
      },
    });
  }
  return {
    nextReview: next,
    nextWorkingText,
    response: {
      ok: true,
      reviewId: next.reviewId,
      documentId: next.documentId,
      chunkId: input.chunkId,
      decision: input.decision,
      reviewGeneration: next.generation,
      unresolvedChunks,
      state: classifyReviewState(next.invalidated, unresolvedChunks),
      documentRevision: { sha256: sha256Text(nextWorkingText) },
    },
    events,
  };
}

/**
 * Accept every chunk of the current partition at once: the reference becomes
 * the working text, exactly what accepting each chunk one at a time
 * converges to — the mirror of prepareClear, which is mass reject. The
 * document does not change. Held chunks are accepted too; their comments
 * surface as orphans. One generation advance, however many chunks resolved.
 */
export function prepareAcceptAll(input: {
  review: ActiveReviewState;
  workingText: string;
}): ReviewMutationPlan<AcceptAllChunksResponse> | ReviewTransitionError {
  if (input.review.invalidated) {
    return {
      ok: false,
      code: "REVIEW_INVALIDATED",
      message: "The review was invalidated by external disk drift.",
    };
  }
  const workingText = normalizeText(input.workingText);
  const next = cloneReview(input.review);
  const partition = computeReviewChunks(next.referenceText, workingText);
  // Every chunk's reference region resolves at once. Remap spans across each
  // accepted chunk, last to first so earlier reference coordinates stay valid
  // while later splices shift the lines behind them.
  for (const chunk of [...partition].reverse()) {
    remapAcrossDecision(
      next,
      chunk,
      chunk.workToLine - chunk.workFromLine - (chunk.refToLine - chunk.refFromLine),
    );
  }
  next.referenceText = workingText;
  next.generation += 1;
  // Every hold now dangles (its chunk is resolved).
  const events = reconcileHolds(next, []);
  events.push(
    {
      event: "review.changed",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        generation: next.generation,
        unresolvedChunks: 0,
      },
    },
    {
      event: "review.resolved",
      payload: {
        reviewId: next.reviewId,
        documentId: next.documentId,
        generation: next.generation,
        unresolvedChunks: 0,
      },
    },
  );
  return {
    nextReview: next,
    nextWorkingText: workingText,
    response: {
      ok: true,
      reviewId: next.reviewId,
      documentId: next.documentId,
      acceptedChunks: partition.length,
      reviewGeneration: next.generation,
      unresolvedChunks: 0,
      state: classifyReviewState(next.invalidated, 0),
      documentRevision: { sha256: sha256Text(workingText) },
    },
    events,
  };
}

/**
 * Clear all unresolved suggestions: the working text becomes the reference.
 * Preserves accepted changes; discards only currently unresolved material.
 */
export function prepareClear(input: {
  review: ActiveReviewState;
  workingText: string;
}): ReviewMutationPlan<ClearReviewResponse> {
  const next = cloneReview(input.review);
  next.generation += 1;
  // Every disagreement is resolved at once: nothing remains to attribute,
  // and every hold dangles — commented holds surface as orphans.
  const events = reconcileHolds(next, []);
  for (const packet of next.packets) {
    packet.refSpans = [];
  }
  events.push({
    event: "review.cleared",
    payload: {
      reviewId: next.reviewId,
      documentId: next.documentId,
      generation: next.generation,
      unresolvedChunks: 0,
    },
  });
  return {
    nextReview: next,
    nextWorkingText: next.referenceText,
    response: {
      ok: true,
      reviewId: next.reviewId,
      documentId: next.documentId,
      state: "cleared",
      documentRevision: { sha256: sha256Text(next.referenceText) },
      reviewGeneration: next.generation,
      unresolvedChunks: 0,
    },
    events,
  };
}

/**
 * Attach a review-level comment. Advances the generation — a comment is a
 * deliberate turn in the conversation, and the generation cursor IS the
 * "what changed since my last turn" query.
 */
export function prepareReviewComment(input: {
  review: ActiveReviewState;
  workingText: string;
  text: string;
}): ReviewMutationPlan<AddReviewCommentResponse> {
  const workingText = normalizeText(input.workingText);
  const next = cloneReview(input.review);
  const comment: ReviewComment = {
    text: input.text,
    createdAt: new Date().toISOString(),
  };
  next.comments.push(comment);
  next.generation += 1;
  return {
    nextReview: next,
    nextWorkingText: workingText,
    response: {
      ok: true,
      reviewId: next.reviewId,
      documentId: next.documentId,
      reviewGeneration: next.generation,
      comment,
    },
    events: [
      {
        event: "review.commented",
        payload: {
          reviewId: next.reviewId,
          documentId: next.documentId,
          comment: comment.text,
          generation: next.generation,
        },
      },
    ],
  };
}

/**
 * Retract a proposal packet. Conservative: only the newest packet, no
 * subsequent packets or user decisions touching its ranges, and its inverse
 * must apply exactly.
 */
export function prepareRetraction(input: {
  review: ActiveReviewState;
  workingText: string;
  packetId: string;
}): ReviewMutationPlan<RetractProposalResponse> | RetractionError {
  const refuse = (message: string): RetractionError => ({
    ok: false,
    code: "PACKET_NOT_RETRACTABLE",
    message,
    reviewId: input.review.reviewId,
    canClearUnresolved: true,
  });
  const packetIndex = input.review.packets.findIndex(
    (packet) => packet.packetId === input.packetId,
  );
  if (packetIndex === -1) {
    return refuse("The packet was not found in its review.");
  }
  if (packetIndex !== input.review.packets.length - 1) {
    return refuse("A later packet has been applied after this one.");
  }
  const packet = input.review.packets[packetIndex];
  if (packet.applicationGeneration !== input.review.generation) {
    return refuse("A review decision was recorded after this proposal was applied.");
  }

  const workingText = normalizeText(input.workingText);
  const reverted = applyPatch(workingText, invertPatch(packet.patch), {
    autoConvertLineEndings: true,
    fuzzFactor: 0,
  });
  if (reverted === false) {
    return refuse(
      "The proposal has been modified or overlapped by later review activity.",
    );
  }

  const next = cloneReview(input.review);
  next.packets.pop();
  next.generation += 1;
  const nextWorkingText = normalizeText(reverted);
  const partition = computeReviewChunks(next.referenceText, nextWorkingText);
  const events = reconcileHolds(next, partition);
  const unresolvedChunks = countPending(next, partition);
  events.push({
    event: "proposal.retracted",
    payload: {
      reviewId: next.reviewId,
      documentId: next.documentId,
      packetId: input.packetId,
      generation: next.generation,
      unresolvedChunks,
    },
  });
  return {
    nextReview: next,
    nextWorkingText,
    response: {
      ok: true,
      retracted: true,
      packetId: input.packetId,
      reviewId: next.reviewId,
      documentId: next.documentId,
      reviewGeneration: next.generation,
      unresolvedChunks,
      documentRevision: { sha256: sha256Text(nextWorkingText) },
    },
    events,
  };
}

/**
 * Reconcile a review against a working text that changed outside it —
 * ordinary editor typing. No decision was made, so the generation does not
 * advance and the document is not rewritten; what changes is which holds
 * still name a live chunk. Returns undefined when nothing moved, so a
 * keystroke that touches no held region costs no commit.
 */
export function prepareWorkingTextEdit(input: {
  review: ActiveReviewState;
  workingText: string;
}): ReviewMutationPlan<void> | undefined {
  const workingText = normalizeText(input.workingText);
  const next = cloneReview(input.review);
  const partition = computeReviewChunks(next.referenceText, workingText);
  const events = reconcileHolds(next, partition);
  const unchanged =
    events.length === 0 &&
    next.holds.length === input.review.holds.length &&
    next.holds.every((hold, index) => {
      const before = input.review.holds[index];
      return (
        hold.chunkId === before.chunkId &&
        hold.referenceFromLine === before.referenceFromLine &&
        hold.workingFromLine === before.workingFromLine
      );
    });
  if (unchanged) {
    return undefined;
  }
  return {
    nextReview: next,
    nextWorkingText: workingText,
    response: undefined,
    events,
  };
}
