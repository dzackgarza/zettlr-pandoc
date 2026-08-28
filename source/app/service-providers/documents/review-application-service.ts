/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewApplicationService
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one owner of review transactions. Every review
 *                  mutation — from the HTTP API, from renderer IPC, from the
 *                  editor's own authority updates — runs here, under one
 *                  per-document lock, in one order:
 *
 *                    read → prepare → PERSIST → commit → emit → broadcast
 *
 *                  The persist step is what the rest of the ordering exists
 *                  for. A sidecar write that fails leaves the committed
 *                  review, the document buffer, the event bus and every pane
 *                  exactly as they were, and the caller is told
 *                  PERSISTENCE_FAILED. An acknowledged mutation is therefore
 *                  a mutation already on disk — the property that makes a
 *                  crash between two operations recoverable.
 *
 *                  Nothing here decides anything. What a mutation MEANS is
 *                  review-transitions.ts, which is pure; what it is allowed
 *                  to do to a document is the authority interface below,
 *                  which DocumentManager implements. This module only orders
 *                  those two against a lock and a filesystem.
 *
 * END HEADER
 */

import type { ChangeSet, Text } from "@codemirror/state";
import { sha256Text } from "@common/util/sha256";
import type {
  AgentErrorCode,
  AgentEvent,
  AgentEventType,
  SubmitProposalResponse,
} from "@dts/common/agent-api";
import type { SerializedUpdate } from "@dts/common/documents";
import type { ActiveReviewState } from "@dts/common/review-domain";
import { Mutex } from "async-mutex";
import {
  normalizeText,
  proposalRequestFingerprint,
  ReviewDiffStore,
  type ReviewDiffStore as ReviewDiffStoreType,
  type ReviewStatus,
  reviewFromSidecar,
  reviewSidecar,
} from "./review-diff-store";
import type { ReviewSidecarData } from "./review-sidecar-schema";
import { ReviewSidecarStore } from "./review-sidecar-store";
import {
  type AcceptAllChunksResponse,
  type AddReviewCommentResponse,
  type ChunkCommentResponse,
  type ChunkDecision,
  type ChunkDecisionResponse,
  type ClaimInput,
  type ClearReviewResponse,
  isTransitionError,
  prepareAcceptAll,
  prepareChunkComment,
  prepareChunkDecision,
  prepareClear,
  prepareProposalSubmission,
  prepareRetraction,
  prepareReviewComment,
  prepareWorkingTextEdit,
  type RetractProposalResponse,
  type ReviewMutationPlan,
} from "./review-transitions";

// ============================================================================
// The authority seam
// ============================================================================

/**
 * A document mutation computed but not yet applied. Everything a synchronous,
 * non-throwing commit needs is in here: serialization (which can throw on a
 * change shape it does not recognize) happens while preparing, so the commit
 * that follows a successful sidecar write cannot fail halfway and consume a
 * version number with no update for peers to pull.
 *
 * `change` is undefined when the candidate text already equals the live text
 * — the common case for Accept and comment, which move no bytes.
 */
export interface PreparedDocumentMutation {
  documentId: string;
  documentPath: string;
  change:
    | {
        changes: ChangeSet;
        update: SerializedUpdate;
        nextText: Text;
        nextVersion: number;
      }
    | undefined;
}

/** What this service is allowed to ask of the document authority. */
export interface ReviewDocumentAuthority {
  resolveDocumentPath: (documentId: string) => string | undefined;

  isDocumentOpen: (documentPath: string) => boolean;

  acquireDocument: (documentId: string) => Promise<{
    documentId: string;
    documentPath: string;
    wasAlreadyLoaded: boolean;
  }>;

  readWorkingText: (documentId: string) => string | undefined;
  readDiskText: (documentPath: string) => Promise<string>;

  /**
   * The hash of the bytes the document was last saved from. A first proposal
   * fences against this rather than the live buffer: the user's own unsaved
   * edits are what the baseline hash binds, and only a write by somebody else
   * must refuse the submission.
   */
  readSavedDiskSha256: (documentId: string) => string | undefined;

  prepareWorkingTextReplacement: (documentId: string, nextText: string) => PreparedDocumentMutation;

  commitWorkingTextReplacement: (prepared: PreparedDocumentMutation) => void;

  releaseTemporaryDocument: (documentId: string) => Promise<void>;

  broadcastReviewState: (documentId: string) => void;
  broadcastReviewCleared: (documentId: string, reviewId: string) => void;
}

/** A committed submission, with the discriminant every route reads. */
export type SubmittedProposal = SubmitProposalResponse & { ok: true };

/**
 * The refusal shape every route already speaks. A precondition refusal adds
 * what the caller needs to re-read from: the revision and generation the
 * review is ACTUALLY at, so a stale client can resynchronize in one round
 * trip instead of polling.
 */
export type ReviewFailure = {
  ok: false;
  code: AgentErrorCode;
  message: string;
  actual?: { sha256: string };
  reviewGeneration?: number;
};

/**
 * What the caller believed when it formed the decision. Both fields are
 * required on every mutation: a decision that cannot say which text and which
 * generation it was made against cannot be checked, and an unchecked decision
 * is the tweak-before-accept race.
 *
 * A review comment moves no document text, so its precondition carries the
 * generation alone.
 */
export interface ReviewMutationPrecondition {
  expectedReviewGeneration: number;
  expectedWorkingSha256: string;
}

interface ReviewApplicationDependencies {
  authority: ReviewDocumentAuthority;
  sidecarDirectory: string;
  emit: (event: AgentEventType, payload: AgentEventPayload) => void;
  warn: (message: string) => void;
}

export type ReviewStoreView = Pick<
  ReviewDiffStoreType,
  | "getReview"
  | "findReviewByReviewId"
  | "listReviews"
  | "getStatus"
  | "getOutstandingChunks"
  | "getReviewDiff"
>;

export interface AttachedReviewQuery {
  attached: true;
  documentId: string;
  documentPath: string;
  review: ActiveReviewState;
  status: ReviewStatus;
  workingText: string;
}

export interface DetachedReviewQuery {
  attached: false;
  sidecar: ReviewSidecarData;
}

export type ReviewQuery = AttachedReviewQuery | DetachedReviewQuery;

/** Read-only review queries exposed to transport adapters. */
export interface ReviewQueryPort {
  getStatus: (documentId: string) => ReviewStatus | undefined;
  getReview: (documentId: string) => ActiveReviewState | undefined;
  getReviewDiff: (documentId: string) => string | undefined;
  getOutstandingChunks: (
    documentId: string,
  ) => ReturnType<ReviewDiffStoreType["getOutstandingChunks"]>;
  findDocumentIdByReviewId: (reviewId: string) => string | undefined;
  findReviewQuery: (reviewId: string) => Promise<ReviewQuery | undefined>;
  listReviewQueries: () => Promise<ReviewQuery[]>;
  readSidecar: (documentPath: string) => Promise<ReviewSidecarData | undefined>;
}

export interface ReviewSavePreparation {
  documentId: string;
  documentPath: string;
  reviewId: string;
  workingText: string;
  survivesSave: boolean;
}

export interface ReattachedReview {
  review: ActiveReviewState;
  workingText: string;
}

export type AgentEventPayload = Partial<Omit<AgentEvent, "event" | "timestamp">> & {
  generation?: number;
};

/** The context a mutation is prepared against, read under the lock. */
interface MutationContext {
  documentId: string;
  documentPath: string;
  review: ActiveReviewState;
  workingText: string;
}

function persistenceFailure(action: string, error: unknown): ReviewFailure {
  return {
    ok: false,
    code: "PERSISTENCE_FAILED",
    message:
      `The review could not be persisted, so ${action} was not applied: ` +
      (error instanceof Error ? error.message : String(error)),
  };
}

export class ReviewApplicationService {
  /**
   * One lock per document, shared by every writer: the agent's mutations, the
   * editor's authority updates, save, detach, reattach, and drift
   * invalidation. Separate locks per transport is what let two of them
   * interleave a read against another's half-applied commit.
   */
  private readonly locks = new Map<string, Mutex>();
  private readonly reviews = new ReviewDiffStore();
  private readonly sidecars: ReviewSidecarStore;

  constructor(private readonly deps: ReviewApplicationDependencies) {
    this.sidecars = new ReviewSidecarStore(deps.sidecarDirectory);
  }

  /** Read projections and persistence are owned by this service. */
  public get reviewStore(): ReviewStoreView {
    return this.reviews;
  }

  public getStatus(documentId: string): ReviewStatus | undefined {
    const workingText = this.deps.authority.readWorkingText(documentId);
    return workingText === undefined ? undefined : this.reviews.getStatus(documentId, workingText);
  }

  public getReview(documentId: string): ActiveReviewState | undefined {
    return this.reviews.getReview(documentId);
  }

  public getReviewDiff(documentId: string): string | undefined {
    const workingText = this.deps.authority.readWorkingText(documentId);
    return workingText === undefined
      ? undefined
      : this.reviews.getReviewDiff(documentId, workingText);
  }

  public getOutstandingChunks(
    documentId: string,
  ): ReturnType<ReviewDiffStoreType["getOutstandingChunks"]> {
    const workingText = this.deps.authority.readWorkingText(documentId);
    return workingText === undefined
      ? undefined
      : this.reviews.getOutstandingChunks(documentId, workingText);
  }

  public findDocumentIdByReviewId(reviewId: string): string | undefined {
    return this.reviews.findReviewByReviewId(reviewId)?.documentId;
  }

  private attachedReviewQuery(review: ActiveReviewState): AttachedReviewQuery | undefined {
    const documentPath = this.deps.authority.resolveDocumentPath(review.documentId);
    const workingText = this.deps.authority.readWorkingText(review.documentId);
    if (documentPath === undefined || workingText === undefined) {
      return undefined;
    }
    const status = this.reviews.getStatus(review.documentId, workingText);
    if (status === undefined) {
      throw new Error(`Review ${review.reviewId} has no status for ${review.documentId}`);
    }
    return {
      attached: true,
      documentId: review.documentId,
      documentPath,
      review,
      status,
      workingText,
    };
  }

  private async detachedReviewQueries(): Promise<DetachedReviewQuery[]> {
    const sidecars = await this.sidecars.list();
    return sidecars
      .filter((sidecar) => !this.deps.authority.isDocumentOpen(sidecar.documentPath))
      .map((sidecar) => ({ attached: false as const, sidecar }));
  }

  public async findReviewQuery(reviewId: string): Promise<ReviewQuery | undefined> {
    const active = this.reviews.findReviewByReviewId(reviewId);
    if (active !== undefined) {
      const attached = this.attachedReviewQuery(active);
      if (attached === undefined) {
        throw new Error(`Review ${reviewId} is attached to a document that is not open`);
      }
      return attached;
    }
    return (await this.detachedReviewQueries()).find(
      (query) => query.sidecar.reviewId === reviewId,
    );
  }

  public async listReviewQueries(): Promise<ReviewQuery[]> {
    const queries: ReviewQuery[] = [];
    for (const review of this.reviews.listReviews()) {
      const attached = this.attachedReviewQuery(review);
      if (attached === undefined) {
        throw new Error(`Review ${review.reviewId} is attached to a document that is not open`);
      }
      queries.push(attached);
    }
    queries.push(...(await this.detachedReviewQueries()));
    return queries;
  }

  /**
   * Commit an editor text update and its suggestion mapping as one review
   * transaction. The callback updates the document authority only after the
   * sidecar write succeeds.
   */
  public async applyWorkingTextEdit(
    documentId: string,
    workingText: string,
    changes: ChangeSet,
    commitDocument: () => void,
  ): Promise<void> {
    await this.withDocumentLock(documentId, async () => {
      await this.applyWorkingTextEditLocked(documentId, workingText, changes, commitDocument);
    });
  }

  /** The same operation for a caller that already holds this document lock. */
  public async applyWorkingTextEditLocked(
    documentId: string,
    workingText: string,
    changes: ChangeSet,
    commitDocument: () => void,
  ): Promise<void> {
    const review = this.reviews.getReview(documentId);
    if (review === undefined) {
      commitDocument();
      return;
    }

    // Read before commitDocument: the authority still holds the text the
    // owner's changes were made against, which is what a suggestion the edit
    // rewrites has to restore. A review without its document is not a state
    // to map anchors in.
    const textBefore = this.deps.authority.readWorkingText(documentId);
    if (textBefore === undefined) {
      throw new Error(`Review ${review.reviewId} has no open document ${documentId}`);
    }

    const plan = prepareWorkingTextEdit({
      review,
      textBefore,
      workingText: normalizeText(workingText),
      changes,
    });
    let writeFailure: unknown;
    let written = false;
    try {
      await this.sidecars.write(
        reviewSidecar(plan?.nextReview ?? review, normalizeText(workingText)),
      );
      written = true;
    } catch (error) {
      writeFailure = error;
    }
    if (!written) {
      throw new Error("The review could not be persisted before the editor update", {
        cause: writeFailure,
      });
    }

    commitDocument();
    if (plan !== undefined) {
      this.reviews.replaceReview(documentId, plan.nextReview!);
      for (const draft of plan.events) {
        this.deps.emit(draft.event, draft.payload);
      }
    }
    this.deps.authority.broadcastReviewState(documentId);
  }

  /** Persist the pending-save fence before the document write begins. */
  public async prepareSave(
    documentId: string,
    savedSha256: string,
  ): Promise<ReviewSavePreparation | undefined> {
    const review = this.reviews.getReview(documentId);
    if (review === undefined) {
      return undefined;
    }
    const workingText = this.deps.authority.readWorkingText(documentId);
    if (workingText === undefined) {
      throw new Error(`Review ${review.reviewId} has no open document ${documentId}`);
    }
    const status = this.reviews.getStatus(documentId, workingText);
    const survivesSave = (status?.unresolvedChunks ?? 0) > 0;
    if (survivesSave) {
      await this.sidecars.write(
        reviewSidecar(review, workingText, {
          beforeDiskSha256: review.diskFenceSha256,
          afterDiskSha256: savedSha256,
        }),
      );
    }
    return {
      documentId,
      documentPath: review.documentPath,
      reviewId: review.reviewId,
      workingText,
      survivesSave,
    };
  }

  /** Complete the review half of a successful document save. */
  public async completeSave(
    preparation: ReviewSavePreparation,
    savedSha256: string,
  ): Promise<void> {
    const review = this.reviews.getReview(preparation.documentId);
    if (review === undefined || review.reviewId !== preparation.reviewId) {
      throw new Error(`Review ${preparation.reviewId} changed during save`);
    }
    if (preparation.survivesSave) {
      const fenced = { ...review, diskFenceSha256: savedSha256 };
      await this.sidecars.write(reviewSidecar(fenced, preparation.workingText));
      this.reviews.replaceReview(preparation.documentId, fenced);
      return;
    }

    this.reviews.removeReview(preparation.documentId);
    this.deps.authority.broadcastReviewCleared(preparation.documentId, preparation.reviewId);
    this.deps.emit("review.completed", {
      reviewId: preparation.reviewId,
      documentId: preparation.documentId,
    });
    try {
      await this.sidecars.delete(preparation.documentPath);
    } catch (error) {
      this.deps.warn(
        `Review sidecar delete failed for ${preparation.documentPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Persist and remove a review when its document detaches. */
  public async detachReview(documentId: string): Promise<void> {
    const review = this.reviews.getReview(documentId);
    if (review !== undefined) {
      if (review.invalidated) {
        await this.sidecars.delete(review.documentPath);
      } else {
        const workingText = this.deps.authority.readWorkingText(documentId);
        if (workingText === undefined) {
          throw new Error(`Review ${review.reviewId} has no open document ${documentId}`);
        }
        await this.sidecars.write(reviewSidecar(review, workingText));
      }
      this.reviews.removeReview(documentId);
    }
  }

  /** Discard dirty editor bytes without fabricating a review projection. */
  public async discardReview(
    documentId: string,
    documentPath: string,
    diskText: string,
  ): Promise<void> {
    const review = this.reviews.getReview(documentId);
    const persisted = review === undefined ? undefined : await this.sidecars.read(documentPath);
    const normalizedDisk = normalizeText(diskText);
    const preserveSavedReview =
      review !== undefined &&
      persisted !== undefined &&
      persisted.reviewId === review.reviewId &&
      !persisted.invalidated &&
      persisted.diskFenceSha256 === sha256Text(normalizedDisk) &&
      persisted.suggestions.some((suggestion) => suggestion.state === "proposed");

    if (preserveSavedReview) {
      return;
    }
    await this.sidecars.delete(documentPath);
    if (review === undefined) {
      return;
    }
    this.reviews.removeReview(documentId);
    this.deps.emit("review.discarded", { reviewId: review.reviewId, documentId });
    this.deps.authority.broadcastReviewCleared(documentId, review.reviewId);
  }

  /** Read, verify, and attach a detached review to an open document. */
  public async reattachReview(
    documentId: string,
    documentPath: string,
    diskText: string,
  ): Promise<ReattachedReview | undefined> {
    let sidecar = await this.sidecars.read(documentPath);
    if (sidecar === undefined) {
      return undefined;
    }
    const diskSha256 = sha256Text(normalizeText(diskText));
    if (sidecar.pendingSave !== undefined) {
      const pendingSave = sidecar.pendingSave;
      const fence =
        diskSha256 === pendingSave.afterDiskSha256
          ? pendingSave.afterDiskSha256
          : diskSha256 === pendingSave.beforeDiskSha256
            ? pendingSave.beforeDiskSha256
            : undefined;
      if (fence === undefined) {
        await this.discardDriftedSidecar(documentId, documentPath, sidecar);
        return undefined;
      }
      sidecar = { ...sidecar, diskFenceSha256: fence };
      delete sidecar.pendingSave;
      await this.sidecars.write(sidecar);
    } else if (diskSha256 !== sidecar.diskFenceSha256) {
      await this.discardDriftedSidecar(documentId, documentPath, sidecar);
      return undefined;
    }

    if (!sidecar.suggestions.some((suggestion) => suggestion.state === "proposed")) {
      await this.sidecars.delete(documentPath);
      return undefined;
    }
    const review = reviewFromSidecar(documentId, sidecar);
    this.reviews.replaceReview(documentId, review);
    this.deps.authority.broadcastReviewState(documentId);
    return { review, workingText: sidecar.workingText };
  }

  private async discardDriftedSidecar(
    documentId: string,
    documentPath: string,
    sidecar: ReviewSidecarData,
  ): Promise<void> {
    await this.sidecars.delete(documentPath);
    this.deps.warn(
      `Review ${sidecar.reviewId} for ${documentPath} was discarded after disk drift.`,
    );
    this.deps.emit("review.invalidated", {
      reviewId: sidecar.reviewId,
      documentId,
    });
  }

  public readSidecar(documentPath: string): Promise<ReviewSidecarData | undefined> {
    return this.sidecars.read(documentPath);
  }

  private lockFor(documentId: string): Mutex {
    const existing = this.locks.get(documentId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Mutex();
    this.locks.set(documentId, created);
    return created;
  }

  /**
   * Run an authority-owned writer under this document's lock. The document
   * authority keeps its own transactions (editor updates, save, detach,
   * reattach) in its own module — it does not keep its own lock.
   */
  public withDocumentLock<T>(documentId: string, run: () => Promise<T>): Promise<T> {
    return this.lockFor(documentId).runExclusive(run);
  }

  // ==========================================================================
  // The transaction sequence
  // ==========================================================================

  /**
   * The one ordering every review mutation obeys. `prepare` is pure: it may
   * refuse, and a refusal reaches the caller having touched nothing.
   *
   * `broadcast` names what the panes are told afterwards. Clearing ends
   * review mode, so it sends the cleared signal instead of a state the
   * widgets would redraw from.
   */
  private async commitReviewMutation<Response>(
    context: MutationContext,
    prepare: () => ReviewMutationPlan<Response> | ReviewFailure,
    broadcast: "state" | "cleared" = "state",
  ): Promise<Response | ReviewFailure> {
    const plan = prepare();
    if ("ok" in plan) {
      return plan;
    }

    const prepared = this.deps.authority.prepareWorkingTextReplacement(
      context.documentId,
      plan.nextWorkingText,
    );

    try {
      if (plan.nextReview === undefined) {
        await this.sidecars.delete(context.documentPath);
      } else {
        await this.sidecars.write(reviewSidecar(plan.nextReview, plan.nextWorkingText));
      }
    } catch (error) {
      return persistenceFailure("the mutation", error);
    }

    if (plan.nextReview === undefined) {
      this.reviews.removeReview(context.documentId);
    } else {
      this.reviews.replaceReview(context.documentId, plan.nextReview);
    }
    this.deps.authority.commitWorkingTextReplacement(prepared);

    for (const draft of plan.events) {
      this.deps.emit(draft.event, draft.payload);
    }
    if (broadcast === "cleared") {
      this.deps.authority.broadcastReviewCleared(context.documentId, context.review.reviewId);
    } else if (plan.nextReview !== undefined) {
      this.deps.authority.broadcastReviewState(context.documentId);
    }
    return plan.response;
  }

  /**
   * Everything a mutation keyed by reviewId needs, read inside the lock: the
   * committed review, its path, and the live working text. A review whose
   * document is closed cannot be decided — closing detaches it to a sidecar.
   */
  private contextForReview(reviewId: string): MutationContext | ReviewFailure {
    const review = this.reviews.findReviewByReviewId(reviewId);
    if (review === undefined) {
      return { ok: false, code: "REVIEW_NOT_FOUND", message: "Review not found." };
    }
    const documentPath = this.deps.authority.resolveDocumentPath(review.documentId);
    const workingText = this.deps.authority.readWorkingText(review.documentId);
    if (documentPath === undefined || workingText === undefined) {
      return {
        ok: false,
        code: "DOCUMENT_CLOSED",
        message: "The reviewed document is no longer open.",
      };
    }
    return { documentId: review.documentId, documentPath, review, workingText };
  }

  /**
   * The caller's own fence: the decision is applied only if the review is
   * still at the generation, and the buffer still holds the bytes, that the
   * reviewer was looking at when they decided.
   *
   * Called with the lock held, before any transition is prepared, because
   * that is the only window in which "the current text" means anything. The
   * generation is checked first: it moves on every review mutation, so a
   * mismatch there names a competing decision, while a text mismatch names
   * an edit — and the reviewer needs to be told which.
   *
   * `expectedWorkingSha256` is undefined only for a review comment, which
   * adjudicates nothing and moves no text.
   */
  private checkPrecondition(
    context: MutationContext,
    precondition: { expectedReviewGeneration: number; expectedWorkingSha256?: string },
  ): ReviewFailure | undefined {
    const actualSha256 = sha256Text(context.workingText);
    if (precondition.expectedReviewGeneration !== context.review.generation) {
      return {
        ok: false,
        code: "REVIEW_GENERATION_MISMATCH",
        message:
          `The review is at generation ${context.review.generation}, not ` +
          `${precondition.expectedReviewGeneration}: something was decided ` +
          "after this one was read. Re-read the review and decide again.",
        actual: { sha256: actualSha256 },
        reviewGeneration: context.review.generation,
      };
    }
    if (
      precondition.expectedWorkingSha256 !== undefined &&
      precondition.expectedWorkingSha256 !== actualSha256
    ) {
      return {
        ok: false,
        code: "REVISION_MISMATCH",
        message:
          "The document text changed after this decision was formed, so the " +
          "chunk it names is not the chunk that would be decided. Re-read " +
          "the chunks and decide again.",
        actual: { sha256: actualSha256 },
        reviewGeneration: context.review.generation,
      };
    }
    return undefined;
  }

  /**
   * The disk fence, checked inside the lock like every other precondition.
   * Drift is terminal: the review is invalidated durably before the refusal
   * is returned, so a crash cannot leave a review that answers proposals
   * against a file that moved underneath it.
   */
  private async checkDiskFence(context: MutationContext): Promise<{ ok: true } | ReviewFailure> {
    if (context.review.invalidated) {
      return {
        ok: false,
        code: "REVIEW_INVALIDATED",
        message: "The review was invalidated by external disk drift.",
      };
    }
    let diskText: string;
    try {
      diskText = await this.deps.authority.readDiskText(context.documentPath);
    } catch {
      return await this.commitInvalidation(
        context,
        "The reviewed document could not be read from disk; the review was invalidated.",
      );
    }
    if (sha256Text(normalizeText(diskText)) === context.review.diskFenceSha256) {
      return { ok: true };
    }
    return await this.commitInvalidation(
      context,
      "The document changed on disk after this review opened; the review was invalidated.",
    );
  }

  /**
   * Commit the invalidated review through the same persist-then-commit
   * ordering, and report the drift. Called with the lock already held.
   */
  private async commitInvalidation(
    context: MutationContext,
    message: string,
  ): Promise<ReviewFailure> {
    const invalidated: ActiveReviewState = { ...context.review, invalidated: true };
    try {
      await this.sidecars.write(reviewSidecar(invalidated, context.workingText));
    } catch (error) {
      return persistenceFailure("the drift invalidation", error);
    }
    this.reviews.replaceReview(context.documentId, invalidated);
    this.deps.emit("review.invalidated", {
      reviewId: invalidated.reviewId,
      documentId: context.documentId,
    });
    this.deps.authority.broadcastReviewCleared(context.documentId, invalidated.reviewId);
    return { ok: false, code: "REVIEW_INVALIDATED", message };
  }

  // ==========================================================================
  // Operations
  // ==========================================================================

  /**
   * Submit an ordered claim sequence against a baseline content hash: applied
   * sequentially and atomically (all-or-nothing), one packet per claim.
   *
   * A closed workspace file is acquired first and released again when the
   * submission commits nothing, so a refused proposal leaves the editor
   * exactly as it found it.
   */
  public async submitProposal(input: {
    documentId: string;
    baselineSha256: string;
    claims: ClaimInput[];
    clientRequestId: string;
    expectedReviewGeneration: number;
  }): Promise<SubmittedProposal | { ok: false; code: string; message: string }> {
    return this.withDocumentLock(input.documentId, async () => {
      if (this.deps.authority.resolveDocumentPath(input.documentId) === undefined) {
        return { ok: false as const, code: "DOCUMENT_NOT_FOUND", message: "Document not found." };
      }
      const acquired = await this.deps.authority.acquireDocument(input.documentId);
      const result = await this.applyProposal(input, acquired.documentPath);
      if (!result.ok && !acquired.wasAlreadyLoaded) {
        await this.deps.authority.releaseTemporaryDocument(input.documentId);
      }
      return result;
    });
  }

  private async applyProposal(
    input: {
      documentId: string;
      baselineSha256: string;
      claims: ClaimInput[];
      clientRequestId: string;
      expectedReviewGeneration: number;
    },
    documentPath: string,
  ): Promise<SubmittedProposal | { ok: false; code: string; message: string }> {
    const requestFingerprint = proposalRequestFingerprint({
      documentId: input.documentId,
      baselineSha256: input.baselineSha256,
      expectedReviewGeneration: input.expectedReviewGeneration,
      claims: input.claims,
    });

    // The ledger lives in the review, so a replay is only meaningful while
    // the review that recorded it exists. A review that completed or was
    // discarded retired its clientRequestIds with it, and the replay is then
    // an ordinary new request judged on its own preconditions.
    const activeReview = this.reviews.getReview(input.documentId);
    const prior = activeReview?.submissions.find(
      (submission) => submission.clientRequestId === input.clientRequestId,
    );
    if (prior !== undefined) {
      return prior.requestFingerprint === requestFingerprint
        ? { ok: true, ...prior.response }
        : {
            ok: false,
            code: "IDEMPOTENCY_CONFLICT",
            message: "clientRequestId was already used for a different proposal request.",
          };
    }

    const workingText = this.deps.authority.readWorkingText(input.documentId);
    if (workingText === undefined) {
      return { ok: false, code: "DOCUMENT_CLOSED", message: "Document is no longer open." };
    }

    let diskText: string;
    try {
      diskText = await this.deps.authority.readDiskText(documentPath);
    } catch (err) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Could not read the document from disk to fence the review: " +
          (err instanceof Error ? err.message : String(err)),
      };
    }
    const diskSha256 = sha256Text(normalizeText(diskText));

    // The baseline hash is the whole external concurrency identity: the
    // patches were built against exactly this text or they were not.
    if (sha256Text(workingText) !== input.baselineSha256) {
      return {
        ok: false,
        code: "REVISION_MISMATCH",
        message: "The document changed after the baseline content was read.",
      };
    }

    // The ingress fence is the document's last saved bytes, not the current
    // live buffer: an ordinary editor may have unsaved changes when the agent
    // submits, and those changes are precisely what the baseline hash binds.
    // Existing reviews instead fence against the bytes present when they
    // opened.
    if (activeReview === undefined) {
      const savedDiskSha256 = this.deps.authority.readSavedDiskSha256(input.documentId);
      if (savedDiskSha256 !== undefined && diskSha256 !== savedDiskSha256) {
        return {
          ok: false,
          code: "REVISION_MISMATCH",
          message: "The document changed on disk after the last saved editor baseline.",
        };
      }
    } else if (diskSha256 !== activeReview.diskFenceSha256) {
      return await this.commitInvalidation(
        {
          documentId: input.documentId,
          documentPath,
          review: activeReview,
          workingText,
        },
        "The document changed on disk after this review opened; the review was invalidated.",
      );
    }

    const currentGeneration = activeReview === undefined ? 0 : activeReview.generation;
    if (input.expectedReviewGeneration !== currentGeneration) {
      return {
        ok: false,
        code: "REVIEW_GENERATION_MISMATCH",
        message: "The review generation no longer matches.",
      };
    }

    // The transition opens the review when none exists, so a sequence that
    // does not apply produces no plan and leaves nothing behind.
    const plan = prepareProposalSubmission({
      review: activeReview,
      documentId: input.documentId,
      documentPath,
      workingText,
      diskSha256,
      claims: input.claims,
      clientRequestId: input.clientRequestId,
      requestFingerprint,
    });
    if (isTransitionError(plan)) {
      return { ok: false, code: plan.code, message: plan.message };
    }

    const prepared = this.deps.authority.prepareWorkingTextReplacement(
      input.documentId,
      plan.nextWorkingText,
    );
    try {
      await this.sidecars.write(reviewSidecar(plan.nextReview!, plan.nextWorkingText));
    } catch (error) {
      return persistenceFailure("the proposal", error);
    }
    this.reviews.replaceReview(input.documentId, plan.nextReview!);
    this.deps.authority.commitWorkingTextReplacement(prepared);
    for (const draft of plan.events) {
      this.deps.emit(draft.event, draft.payload);
    }
    this.deps.authority.broadcastReviewState(input.documentId);
    return { ok: true, ...plan.response };
  }

  /**
   * Apply one accept/reject decision to a review chunk. The renderer's
   * buttons and the HTTP API both land here, so no pane ever mutates review
   * state and there is no pane report to reconcile.
   */
  public async decideChunk(
    reviewId: string,
    chunkId: string,
    decision: ChunkDecision,
    precondition: ReviewMutationPrecondition,
  ): Promise<ChunkDecisionResponse | ReviewFailure> {
    return this.runKeyedByReview(reviewId, async (context) => {
      const fence = await this.checkDiskFence(context);
      if (!fence.ok) {
        return fence;
      }
      const stale = this.checkPrecondition(context, precondition);
      if (stale !== undefined) {
        return stale;
      }
      return await this.commitReviewMutation(context, () => {
        const plan = prepareChunkDecision({
          review: context.review,
          workingText: context.workingText,
          chunkId,
          decision,
        });
        if (isTransitionError(plan)) {
          if (plan.code === "CHUNK_NOT_FOUND") {
            // The caller used an id that is not outstanding. Re-broadcast so
            // every pane redraws from current state.
            this.deps.warn(`Chunk decision refused for ${context.documentPath}: ${plan.message}`);
            this.deps.authority.broadcastReviewState(context.documentId);
          }
          return { ok: false, code: plan.code, message: plan.message };
        }
        return plan;
      });
    });
  }

  /**
   * Attach a comment to one outstanding chunk without deciding it. Fenced
   * like a decision so a note formed against a stale pane must refuse.
   */
  public async commentChunk(
    reviewId: string,
    chunkId: string,
    text: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<ChunkCommentResponse | ReviewFailure> {
    return this.runKeyedByReview(reviewId, async (context) => {
      const fence = await this.checkDiskFence(context);
      if (!fence.ok) {
        return fence;
      }
      const stale = this.checkPrecondition(context, precondition);
      if (stale !== undefined) {
        return stale;
      }
      return await this.commitReviewMutation(context, () => {
        const plan = prepareChunkComment({
          review: context.review,
          workingText: context.workingText,
          chunkId,
          text,
        });
        return isTransitionError(plan)
          ? { ok: false, code: plan.code, message: plan.message }
          : plan;
      });
    });
  }

  /**
   * Accept every outstanding chunk at once — the mirror of clearReview, which
   * is mass reject. The document text does not change, so nothing is applied.
   */
  public async acceptAllChunks(
    reviewId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<AcceptAllChunksResponse | ReviewFailure> {
    return this.runKeyedByReview(reviewId, async (context) => {
      const fence = await this.checkDiskFence(context);
      if (!fence.ok) {
        return fence;
      }
      const stale = this.checkPrecondition(context, precondition);
      if (stale !== undefined) {
        return stale;
      }
      return await this.commitReviewMutation(context, () => {
        const plan = prepareAcceptAll({
          review: context.review,
          workingText: context.workingText,
        });
        return isTransitionError(plan)
          ? { ok: false, code: plan.code, message: plan.message }
          : plan;
      });
    });
  }

  /** Clear every unresolved suggestion: mass reject, ending review mode. */
  public async clearReview(
    reviewId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<ClearReviewResponse | ReviewFailure> {
    return this.runKeyedByReview(reviewId, async (context) => {
      const fence = await this.checkDiskFence(context);
      if (!fence.ok) {
        return fence;
      }
      const stale = this.checkPrecondition(context, precondition);
      if (stale !== undefined) {
        return stale;
      }
      return await this.commitReviewMutation(
        context,
        () => prepareClear({ review: context.review, workingText: context.workingText }),
        "cleared",
      );
    });
  }

  /** Add a review-level comment through the provider-owned review state. */
  public async addReviewComment(
    reviewId: string,
    text: string,
    expectedReviewGeneration: number,
  ): Promise<AddReviewCommentResponse | ReviewFailure> {
    return this.runKeyedByReview(reviewId, async (context) => {
      const stale = this.checkPrecondition(context, { expectedReviewGeneration });
      if (stale !== undefined) {
        return stale;
      }
      return await this.commitReviewMutation(context, () =>
        prepareReviewComment({
          review: context.review,
          workingText: context.workingText,
          text,
        }),
      );
    });
  }

  /**
   * Retract a proposal packet. Keyed by packetId, so the owning review is
   * found first and the lock is taken on its document.
   */
  public async retractProposal(
    packetId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<
    RetractProposalResponse | (ReviewFailure & { reviewId: string; canClearUnresolved: boolean })
  > {
    // Reviews and their packets are few; a scan is cheaper to keep correct
    // than an index every mutation must remember to maintain.
    const owner = this.reviews
      .listReviews()
      .find((candidate) => candidate.packets.some((packet) => packet.packetId === packetId));
    if (owner === undefined) {
      return {
        ok: false,
        code: "PACKET_NOT_RETRACTABLE",
        message: "The packet was not found.",
        reviewId: "",
        canClearUnresolved: true,
      };
    }
    return await this.withDocumentLock(owner.documentId, async () => {
      const context = this.contextForReview(owner.reviewId);
      if ("ok" in context) {
        return { ...context, reviewId: owner.reviewId, canClearUnresolved: false };
      }
      const stale = this.checkPrecondition(context, precondition);
      if (stale !== undefined) {
        return { ...stale, reviewId: owner.reviewId, canClearUnresolved: true };
      }
      const result = await this.commitReviewMutation(context, () => {
        const plan = prepareRetraction({
          review: context.review,
          workingText: context.workingText,
          packetId,
        });
        return isTransitionError(plan)
          ? { ok: false, code: plan.code as AgentErrorCode, message: plan.message }
          : plan;
      });
      if ("ok" in result && !result.ok) {
        return { ...result, reviewId: context.review.reviewId, canClearUnresolved: true };
      }
      return result;
    });
  }

  /**
   * External disk drift observed by the watchdog. The review stops accepting
   * proposals; both the live editor content and the external disk content are
   * preserved.
   */
  public async invalidateOnDiskDrift(documentId: string): Promise<void> {
    await this.withDocumentLock(documentId, async () => {
      const review = this.reviews.getReview(documentId);
      const documentPath = this.deps.authority.resolveDocumentPath(documentId);
      const workingText = this.deps.authority.readWorkingText(documentId);
      if (
        review === undefined ||
        review.invalidated ||
        documentPath === undefined ||
        workingText === undefined
      ) {
        return;
      }
      const failure = await this.commitInvalidation(
        { documentId, documentPath, review, workingText },
        "The document changed on disk.",
      );
      if (failure.code === "PERSISTENCE_FAILED") {
        // Nothing was committed, so the review is still live and still
        // answering. The watchdog has no caller to refuse; say so loudly.
        this.deps.warn(failure.message);
      }
    });
  }

  private async runKeyedByReview<T>(
    reviewId: string,
    run: (context: MutationContext) => Promise<T | ReviewFailure>,
  ): Promise<T | ReviewFailure> {
    const located = this.reviews.findReviewByReviewId(reviewId);
    if (located === undefined) {
      return { ok: false, code: "REVIEW_NOT_FOUND", message: "Review not found." };
    }
    return await this.withDocumentLock(located.documentId, async () => {
      const context = this.contextForReview(reviewId);
      if ("ok" in context) {
        return context;
      }
      return await run(context);
    });
  }
}
