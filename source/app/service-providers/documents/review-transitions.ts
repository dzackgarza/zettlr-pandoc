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
import { ChangeSet, Text, type ChangeDesc } from "@codemirror/state";
import {
  applyPatch,
  diffWordsWithSpace,
  parsePatch,
  reversePatch,
  type StructuredPatch,
} from "diff";
import path from "path";
import type {
  AgentEvent,
  AgentEventType,
  DocumentRevision,
  ReviewComment,
  ReviewState,
  SubmitProposalResponse,
} from "@dts/common/agent-api";
import type {
  ActiveReviewState,
  ReviewPacket,
  ReviewSuggestion,
} from "@dts/common/review-domain";
import {
  classifyReviewState,
  normalizeText,
} from "./review-diff-store";
import { sha256Text } from "@common/util/sha256";
import { mapSuggestionThroughChanges } from "@common/util/review-suggestion-anchors";

// ============================================================================
// Plan and error shapes
// ============================================================================

/**
 * One event a committed plan owes its audiences, before the emitter fills in
 * whatever the payload left implicit. Drafted here and emitted by the caller:
 * a plan that is never committed must announce nothing.
 */
export interface AgentEventDraft {
  event: AgentEventType;
  payload: Partial<Omit<AgentEvent, "event" | "timestamp">> & { generation?: number };
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

/** What the reviewer can decide about one chunk. */
export type ChunkDecision = "accept" | "reject";

/**
 * The three decision shapes are owned here rather than generated from the
 * OpenAPI document: adjudication is the human's, reachable only through the
 * editor's typed IPC channels, so no agent-facing contract describes it.
 */
export interface ChunkDecisionResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  chunkId: string;
  decision: ChunkDecision;
  reviewGeneration: number;
  unresolvedChunks: number;
  state: ReviewState;
  documentRevision: DocumentRevision;
}

export interface AcceptAllChunksResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  /** How many chunks the sweep resolved. */
  acceptedChunks: number;
  reviewGeneration: number;
  unresolvedChunks: number;
  state: ReviewState;
  documentRevision: DocumentRevision;
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

/** A chunk-anchored comment landed: annotation only, no state change. */
export interface ChunkCommentResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  chunkId: string;
  reviewGeneration: number;
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
    packets: review.packets.map((packet) => ({ ...packet })),
    suggestions: review.suggestions.map((suggestion) => ({
      ...suggestion,
      anchors: suggestion.anchors.map((span) => ({ ...span })),
      restorations: suggestion.restorations.map((restoration) => ({ ...restoration })),
    })),
    submissions: review.submissions.map((submission) => ({
      ...submission,
      packetIds: [...submission.packetIds],
      response: { ...submission.response },
    })),
    chunkComments: review.chunkComments.map((note) => ({ ...note })),
    comments: review.comments.map((comment) => ({ ...comment })),
  };
}

function suggestionsForChange(
  before: string,
  after: string,
  packetId: string,
): ReviewSuggestion[] {
  const changes = diffWordsWithSpace(before, after);
  const suggestions: ReviewSuggestion[] = [];
  let afterOffset = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      afterOffset += change.value.length;
      continue;
    }
    const adjacent = changes[index + 1];
    const removedText =
      change.removed
        ? change.value
        : change.added && adjacent?.removed
          ? adjacent.value
          : "";
    const addition = changes[index + 1];
    const addedText =
      change.removed && addition?.added
        ? addition.value
        : change.added
          ? change.value
          : "";
    if (
      (change.removed && addition?.added) ||
      (change.added && adjacent?.removed)
    ) {
      index += 1;
    }
    const appliedLength = addedText.length;
    const kind =
      removedText === "" ? "insertion" : addedText === "" ? "deletion" : "substitution";
    suggestions.push({
      suggestionId: randomUUID(),
      packetId,
      kind,
      removedText,
      restorations: removedText === "" ? [] : [{ at: afterOffset, text: removedText }],
      anchors: [{ from: afterOffset, to: afterOffset + addedText.length }],
      seam: afterOffset,
      state: "proposed",
    });
    afterOffset += appliedLength;
  }
  // One suggestion per changed region, not per claim. A claim that rewrites
  // two identical occurrences, or five lines, is adjudicated region by region:
  // the reviewer accepts the ones they want and rejects the rest. Merging a
  // claim's regions into one suggestion would make a claim all-or-nothing and
  // hand the reviewer a chunk whose text spans the whole document.
  return suggestions;
}

function changeSetForTextTransition(before: string, after: string): ChangeSet {
  const changes = diffWordsWithSpace(before, after);
  const specs: Array<{ from: number; to: number; insert: string }> = [];
  let beforeOffset = 0;
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      beforeOffset += change.value.length;
      index += 1;
      continue;
    }
    const from = beforeOffset;
    let insert = "";
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const part = changes[index];
      if (part.removed) {
        beforeOffset += part.value.length;
      } else {
        insert += part.value;
      }
      index += 1;
    }
    specs.push({ from, to: beforeOffset, insert });
  }
  return ChangeSet.of(specs, before.length);
}

function mapSuggestionAnchors(
  suggestions: ReviewSuggestion[],
  changes: ChangeDesc,
  textBefore: string,
): boolean {
  let changed = false;

  for (const suggestion of suggestions) {
    if (suggestion.state !== "proposed") {continue;}
    const mapped = mapSuggestionThroughChanges(
      suggestion,
      changes,
      (from, to) => textBefore.slice(from, to),
    );
    changed ||= mapped.changed;
    suggestion.anchors = mapped.anchors;
    suggestion.seam = mapped.seam;
    if (mapped.destroyed) {
      suggestion.state = "withdrawn";
      changed = true;
      continue;
    }
    // The restoration and the kind are the reference read two other ways, so
    // both are re-derived from it rather than mapped beside it.
    suggestion.removedText = mapped.removedText;
    suggestion.restorations = mapped.removedText === ""
      ? []
      : [{ at: mapped.seam, text: mapped.removedText }];
    suggestion.kind = mapped.removedText === ""
      ? "insertion"
      : mapped.anchors.every((anchor) => anchor.from === anchor.to)
        ? "deletion"
        : "substitution";
  }
  return changed;
}

function rejectSuggestions(review: ActiveReviewState, workingText: string): string {
  const proposed = review.suggestions.filter((suggestion) => suggestion.state === "proposed");
  const operations = proposed.flatMap((suggestion) => [
    ...suggestion.anchors.map((span) => ({ from: span.from, to: span.to, insert: "" })),
    ...suggestion.restorations.map((restoration) => ({
      from: restoration.at,
      to: restoration.at,
      insert: restoration.text,
    })),
  ]).sort((left, right) => right.from - left.from || right.to - left.to);
  let result = workingText;
  for (const operation of operations) {
    result = result.slice(0, operation.from) + operation.insert + result.slice(operation.to);
  }
  for (const suggestion of proposed) {suggestion.state = "rejected";}
  return result;
}

function rejectionChangeSet(
  suggestions: readonly ReviewSuggestion[],
  documentLength: number,
): ChangeSet {
  const specs = suggestions
    .filter((suggestion) => suggestion.state === "proposed")
    .flatMap((suggestion) => suggestion.anchors.map((anchor) => ({
      from: anchor.from,
      to: anchor.to,
      insert: "",
    })));
  for (const suggestion of suggestions) {
    if (suggestion.state !== "proposed") {continue;}
    for (const restoration of suggestion.restorations) {
      const replacement = specs.find((spec) => spec.from === restoration.at);
      if (replacement === undefined) {
        specs.push({ from: restoration.at, to: restoration.at, insert: restoration.text });
      } else {
        replacement.insert += restoration.text;
      }
    }
  }
  specs.sort((left, right) => left.from - right.from || left.to - right.to);
  return ChangeSet.of(specs, documentLength);
}

function applyChangeSet(workingText: string, changes: ChangeSet): string {
  return changes.apply(Text.of(workingText.split("\n"))).toString();
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

/**
 * Apply an ordered claim sequence, opening the review when none exists yet.
 * Opening here is what makes an all-or-nothing batch honest: a sequence that
 * does not apply produces no plan at all, so there is no empty review to
 * roll back and no `review.started` announcing one.
 *
 * Each patch maps existing suggestions before its new suggestions are added.
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
          suggestions: [],
          generation: 0,
          packets: [],
          submissions: [],
          chunkComments: [],
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
    const packetId = randomUUID();
    const packet: ReviewPacket = {
      packetId,
      reviewId: next.reviewId,
      clientRequestId: input.clientRequestId,
      requestFingerprint: input.requestFingerprint,
      description: step.description,
      appliedAt: new Date().toISOString(),
      patch: step.patch,
      applicationGeneration: next.generation + 1,
    };
    next.packets.push(packet);
    mapSuggestionAnchors(
      next.suggestions,
      changeSetForTextTransition(textBefore, step.textAfter),
      textBefore,
    );
    next.suggestions.push(...suggestionsForChange(textBefore, step.textAfter, packetId));
    next.generation += 1;
    packetIds.push(packet.packetId);
    textBefore = step.textAfter;
  }

  const nextWorkingText = sequence.steps[sequence.steps.length - 1].textAfter;
  const unresolvedChunks = next.suggestions.filter((suggestion) => suggestion.state === "proposed").length;

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
 * Decide a single suggestion by its stable id — the ONE decision path
 * for both verbs.
 *
 * Accept makes the reference agree with the working text on the chunk (the
 * document does not change). Reject computes the working text with the chunk
 * restored to the reference. A stale id — the region changed since the
 * caller read it — fails with CHUNK_NOT_FOUND rather than acting on a
 * region that no longer means what the caller thought.
 */
export function prepareChunkDecision(input: {
  review: ActiveReviewState;
  workingText: string;
  chunkId: string;
  decision: ChunkDecision;
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
  const suggestion = next.suggestions.find(
    (candidate) => candidate.suggestionId === input.chunkId && candidate.state === "proposed",
  );
  if (suggestion === undefined) {
    return {
      ok: false,
      code: "CHUNK_NOT_FOUND",
      message: `No unresolved chunk ${input.chunkId} exists at review generation ${next.generation}.`,
    };
  }
  let nextWorkingText = workingText;
  if (input.decision === "accept") {
    suggestion.state = "accepted";
  } else {
    const changes = rejectionChangeSet([suggestion], workingText.length);
    nextWorkingText = applyChangeSet(workingText, changes);
    suggestion.state = "rejected";
    mapSuggestionAnchors(next.suggestions, changes, workingText);
  }
  const unresolvedChunks = next.suggestions.filter(
    (candidate) => candidate.state === "proposed",
  ).length;
  next.generation += 1;
  const events: AgentEventDraft[] = [{
    event: "review.changed",
    payload: {
      reviewId: next.reviewId,
      documentId: next.documentId,
      generation: next.generation,
      unresolvedChunks,
    },
  }];

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
 * Set, replace, or remove the comment on one outstanding chunk WITHOUT
 * deciding it. Pure annotation: the chunk stays outstanding and no text
 * moves. Non-empty text upserts the note; empty text removes it. Both
 * advance the generation — like a review-level comment, a chunk note is a
 * deliberate turn in the conversation — except emptying a chunk that
 * carries no note, which is a no-op and does NOT advance the generation.
 */
export function prepareChunkComment(input: {
  review: ActiveReviewState;
  workingText: string;
  chunkId: string;
  text: string;
}): ReviewMutationPlan<ChunkCommentResponse> | ReviewTransitionError {
  if (input.review.invalidated) {
    return {
      ok: false,
      code: "REVIEW_INVALIDATED",
      message: "The review was invalidated by external disk drift.",
    };
  }
  const workingText = normalizeText(input.workingText);
  const next = cloneReview(input.review);
  const suggestion = next.suggestions.find(
    (candidate) => candidate.suggestionId === input.chunkId && candidate.state === "proposed",
  );
  if (suggestion === undefined) {
    return {
      ok: false,
      code: "CHUNK_NOT_FOUND",
      message: `No unresolved chunk ${input.chunkId} exists at review generation ${next.generation}.`,
    };
  }
  const response = (): ChunkCommentResponse => ({
    ok: true,
    reviewId: next.reviewId,
    documentId: next.documentId,
    chunkId: input.chunkId,
    reviewGeneration: next.generation,
  });
  const hadNote = next.chunkComments.some((note) => note.chunkId === input.chunkId);
  if (input.text === "" && !hadNote) {
    return { nextReview: next, nextWorkingText: workingText, response: response(), events: [] };
  }
  next.chunkComments = next.chunkComments.filter((note) => note.chunkId !== input.chunkId);
  if (input.text !== "") {
    next.chunkComments.push({
      chunkId: input.chunkId,
      comment: input.text,
      commentedAt: new Date().toISOString(),
    });
  }
  next.generation += 1;
  const events: AgentEventDraft[] = [{
    event: "review.commented",
    payload: {
      reviewId: next.reviewId,
      documentId: next.documentId,
      chunkId: input.chunkId,
      // Absent comment = the reviewer cleared the note off this chunk.
      ...(input.text === "" ? {} : { comment: input.text }),
      generation: next.generation,
      unresolvedChunks: next.suggestions.filter((candidate) => candidate.state === "proposed").length,
    },
  }];
  return { nextReview: next, nextWorkingText: workingText, response: response(), events };
}

/**
 * Accept every proposed suggestion at once. The document does not change.
 * Owner edits stay outside the accepted suggestions. The generation advances
 * once.
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
  const proposedCount = next.suggestions.filter((suggestion) => suggestion.state === "proposed").length;
  for (const suggestion of next.suggestions) {
    if (suggestion.state === "proposed") {suggestion.state = "accepted";}
  }
  next.generation += 1;
  const events: AgentEventDraft[] = [
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
  ];
  return {
    nextReview: next,
    nextWorkingText: workingText,
    response: {
      ok: true,
      reviewId: next.reviewId,
      documentId: next.documentId,
      acceptedChunks: proposedCount,
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
  const workingText = normalizeText(input.workingText);
  const nextWorkingText = rejectSuggestions(next, workingText);
  next.generation += 1;
  const events: AgentEventDraft[] = [{
    event: "review.cleared",
    payload: {
      reviewId: next.reviewId,
      documentId: next.documentId,
      generation: next.generation,
      unresolvedChunks: 0,
    },
  }];
  return {
    nextReview: next,
    nextWorkingText,
    response: {
      ok: true,
      reviewId: next.reviewId,
      documentId: next.documentId,
      state: "cleared",
      documentRevision: { sha256: sha256Text(nextWorkingText) },
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
  const retractedSuggestions = next.suggestions.filter(
    (suggestion) => suggestion.packetId === input.packetId,
  );
  const retractionChanges = rejectionChangeSet(
    retractedSuggestions,
    workingText.length,
  );
  const exactReverted = applyChangeSet(workingText, retractionChanges);
  if (exactReverted !== normalizeText(reverted)) {
    return refuse("The proposal no longer matches its stored suggestion entities.");
  }
  next.packets.pop();
  const retractedSuggestionIds = new Set(
    next.suggestions
      .filter((suggestion) => suggestion.packetId === input.packetId)
      .map((suggestion) => suggestion.suggestionId),
  );
  next.suggestions = next.suggestions.filter(
    (suggestion) => suggestion.packetId !== input.packetId,
  );
  next.chunkComments = next.chunkComments.filter(
    (comment) => !retractedSuggestionIds.has(comment.chunkId),
  );
  next.generation += 1;
  const nextWorkingText = normalizeText(reverted);
  mapSuggestionAnchors(next.suggestions, retractionChanges, workingText);
  const unresolvedChunks = next.suggestions.filter(
    (suggestion) => suggestion.state === "proposed",
  ).length;
  const events: AgentEventDraft[] = [{
    event: "proposal.retracted",
    payload: {
      reviewId: next.reviewId,
      documentId: next.documentId,
      packetId: input.packetId,
      generation: next.generation,
      unresolvedChunks,
    },
  }];
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
 * advance and the document is not rewritten. Returns undefined when no
 * suggestion coordinate or state changed.
 */
export function prepareWorkingTextEdit(input: {
  review: ActiveReviewState;
  /** The text the edit was made against — the reference the owner rewrote. */
  textBefore: string;
  workingText: string;
  changes: ChangeDesc;
}): ReviewMutationPlan<void> | undefined {
  const workingText = normalizeText(input.workingText);
  const next = cloneReview(input.review);
  const anchorsChanged = mapSuggestionAnchors(
    next.suggestions,
    input.changes,
    normalizeText(input.textBefore),
  );
  if (!anchorsChanged) {
    return undefined;
  }
  return {
    nextReview: next,
    nextWorkingText: workingText,
    response: undefined,
    events: [],
  };
}
