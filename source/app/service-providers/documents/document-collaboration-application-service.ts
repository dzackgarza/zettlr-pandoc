/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CollaborationApplicationService
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one owner of a document's collaboration transactions:
 *                  its review and its annotations together. Every mutation —
 *                  from the HTTP API, from renderer IPC, from the editor's
 *                  own authority updates — runs here, under one per-document
 *                  lock, in one order:
 *
 *                    read → prepare → PERSIST → commit → emit → broadcast
 *
 *                  The persist step is what the rest of the ordering exists
 *                  for. A sidecar write that fails leaves the committed
 *                  review, the committed annotations, the document buffer,
 *                  the event bus and every pane exactly as they were, and
 *                  the caller is told PERSISTENCE_FAILED. An acknowledged
 *                  mutation is therefore a mutation already on disk — the
 *                  property that makes a crash between two operations
 *                  recoverable, and invariant I2 in one sentence.
 *
 *                  ONE sidecar carries both halves, so ONE write commits
 *                  both. That is why a proposal and the annotations it
 *                  addresses cannot land apart (a linked submission is one
 *                  write), and why a review mutation cannot drop a
 *                  document's annotations (the write names both halves and
 *                  neither has a default). The two halves keep separate
 *                  generations: a proposal does not invalidate a decision
 *                  the owner formed by reading the annotations panel, and an
 *                  annotation reply does not invalidate an adjudication.
 *
 *                  Nothing here decides anything. What a mutation MEANS is
 *                  review-transitions.ts and annotation-transitions.ts,
 *                  which are pure; what it is allowed to do to a document is
 *                  the authority interface below, which DocumentManager
 *                  implements. This module only orders those two against a
 *                  lock and a filesystem.
 *
 * END HEADER
 */

import { Mutex } from "async-mutex";
import type { ChangeSet, Text } from "@codemirror/state";
import type {
  AgentErrorCode,
  AgentEvent,
  AgentEventType,
  SubmitProposalResponse,
} from "@dts/common/agent-api";
import type { SerializedUpdate } from "@dts/common/documents";
import type { ActiveReviewState } from "@dts/common/review-domain";
import type {
  AnnotationActor,
  AnnotationMessage,
  AnnotationSet,
  TextAnnotation,
} from "@dts/common/annotation-domain";
import {
  proposalRequestFingerprint,
  collaborationSidecar,
  normalizeText,
  ReviewDiffStore,
  reviewFromSidecar,
  type ReviewBearingSidecar,
  type ReviewStatus,
  type ReviewDiffStore as ReviewDiffStoreType,
} from "./review-diff-store";
import { sha256Text } from "@common/util/sha256";
import { CollaborationSidecarStore } from "./collaboration-sidecar-store";
import type { CollaborationSidecarData } from "./collaboration-sidecar-schema";
import {
  emptyAnnotationSet,
  prepareAnnotationCreation,
  prepareAnnotationDeletion,
  prepareAnnotationMappingThroughOwnerEdit,
  prepareAnnotationMessage,
  prepareAnnotationOrphaning,
  prepareAnnotationProposalLinkage,
  prepareAnnotationReattachment,
  prepareAnnotationReopen,
  prepareAnnotationResolution,
  type AnnotationMutationPlan,
  type AnnotationTransitionError,
} from "./annotation-transitions";
import {
  isTransitionError,
  prepareAcceptAll,
  prepareChunkComment,
  prepareChunkDecision,
  prepareClear,
  prepareProposalSubmission,
  prepareRetraction,
  prepareReviewComment,
  prepareWorkingTextEdit,
  type AcceptAllChunksResponse,
  type AddReviewCommentResponse,
  type ChunkCommentResponse,
  type ChunkDecision,
  type ChunkDecisionResponse,
  type ClaimInput,
  type ClearReviewResponse,
  type ReviewMutationPlan,
  type RetractProposalResponse,
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
export interface CollaborationDocumentAuthority {
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

  prepareWorkingTextReplacement: (
    documentId: string,
    nextText: string,
  ) => PreparedDocumentMutation;

  commitWorkingTextReplacement: (prepared: PreparedDocumentMutation) => void;

  releaseTemporaryDocument: (documentId: string) => Promise<void>;

  /**
   * The last step of every mutation: tell the panes what the document's
   * collaboration state now is. Called after the commit, never before, so a
   * pane cannot redraw from state that is not yet on disk.
   */
  broadcastCollaborationState: (documentId: string) => void;
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

interface CollaborationApplicationDependencies {
  authority: CollaborationDocumentAuthority;
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
  sidecar: ReviewBearingSidecar;
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
  readSidecar: (documentPath: string) => Promise<CollaborationSidecarData | undefined>;
}

export interface ReviewSavePreparation {
  documentId: string;
  documentPath: string;
  /** Absent when the document carries annotations and no review. */
  reviewId: string | undefined;
  workingText: string;
  survivesSave: boolean;
}

/**
 * What a document got back when it opened. `workingText` is present only
 * when a review was restored: only a review gives the persisted text a claim
 * on the buffer, and an annotation-bearing document without one opens on
 * its file.
 */
export interface ReattachedCollaboration {
  review: ActiveReviewState | undefined;
  annotations: AnnotationSet;
  workingText: string | undefined;
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

/**
 * The committed annotation state of one document, plus the two facts a
 * sidecar write needs that the annotations themselves do not carry.
 *
 * The path is remembered rather than resolved, because detaching a document
 * has to write its annotations through AFTER the authority has stopped
 * answering for it. The fence is remembered because a document may carry
 * annotations with no review at all, and drift is then measured against
 * nothing else.
 */
interface AnnotationDocumentState {
  documentPath: string;
  diskFenceSha256: string;
  annotations: AnnotationSet;
}

/** The refusal an annotation mutation answers with when it never ran. */
export type AnnotationFailure = { ok: false; code: AgentErrorCode; message: string };

function persistenceFailure(action: string, error: unknown): ReviewFailure {
  return {
    ok: false,
    code: "PERSISTENCE_FAILED",
    message:
      `The collaboration state could not be persisted, so ${action} was not applied: ` +
      (error instanceof Error ? error.message : String(error)),
  };
}

export class CollaborationApplicationService {
  /**
   * One lock per document, shared by every writer: the agent's mutations, the
   * owner's annotations, the editor's authority updates, save, detach,
   * reattach, and drift invalidation. Separate locks per transport is what
   * let two of them interleave a read against another's half-applied commit.
   */
  private readonly locks = new Map<string, Mutex>();
  private readonly reviews = new ReviewDiffStore();
  /**
   * Committed annotations per open document. The review's twin: a candidate
   * set replaces the entry here only after the sidecar holding it is on disk.
   */
  private readonly annotationStates = new Map<string, AnnotationDocumentState>();
  private readonly sidecars: CollaborationSidecarStore;

  constructor(private readonly deps: CollaborationApplicationDependencies) {
    this.sidecars = new CollaborationSidecarStore(deps.sidecarDirectory);
  }

  /** Read projections and persistence are owned by this service. */
  public get reviewStore(): ReviewStoreView {
    return this.reviews;
  }

  // ==========================================================================
  // The annotation half of a document's collaboration state
  // ==========================================================================

  /** The committed annotations of a document. Empty is a real answer. */
  public getAnnotations(documentId: string): AnnotationSet {
    return this.annotationStates.get(documentId)?.annotations ?? emptyAnnotationSet();
  }

  /**
   * The whole sidecar for a document, both halves named. Every write in this
   * module goes through here, which is what makes it impossible for a review
   * mutation to persist a sidecar that has forgotten the document's
   * annotations: there is no annotation default to fall through to.
   */
  private sidecarFor(
    documentId: string,
    next: {
      documentPath: string;
      workingText: string;
      review: ActiveReviewState | undefined;
      annotations?: AnnotationSet;
      diskFenceSha256?: string;
      pendingSave?: CollaborationSidecarData["pendingSave"];
    },
  ): CollaborationSidecarData {
    const committed = this.annotationStates.get(documentId);
    return collaborationSidecar({
      documentPath: next.documentPath,
      workingText: next.workingText,
      // One place decides the fence: the caller's, else the open review's,
      // else the annotations'. The last branch is reached only by a document
      // with neither half, whose sidecar the store deletes rather than
      // writes, so the value never reaches a file.
      diskFenceSha256:
        next.diskFenceSha256 ??
        next.review?.diskFenceSha256 ??
        committed?.diskFenceSha256 ??
        sha256Text(next.workingText),
      review: next.review,
      annotations: next.annotations ?? committed?.annotations ?? emptyAnnotationSet(),
      pendingSave: next.pendingSave,
    });
  }

  /**
   * Install a candidate annotation set as the state of record. Called only
   * after the sidecar carrying it returned from the filesystem, so the map
   * never holds a set that is not already on disk (I2).
   */
  private commitAnnotations(
    documentId: string,
    committed: { documentPath: string; diskFenceSha256: string; annotations: AnnotationSet },
  ): void {
    this.annotationStates.set(documentId, { ...committed });
  }

  public getStatus(documentId: string): ReviewStatus | undefined {
    const workingText = this.deps.authority.readWorkingText(documentId);
    return workingText === undefined
      ? undefined
      : this.reviews.getStatus(documentId, workingText);
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
      .filter((sidecar): sidecar is ReviewBearingSidecar => sidecar.review !== null)
      .filter((sidecar) => !this.deps.authority.isDocumentOpen(sidecar.documentPath))
      .map((sidecar) => ({ attached: false as const, sidecar }));
  }

  public async findReviewQuery(reviewId: string): Promise<ReviewQuery | undefined> {
    const active = this.reviews.findReviewByReviewId(reviewId);
    if (active !== undefined) {
      const attached = this.attachedReviewQuery(active);
      if (attached === undefined) {
        throw new Error(
          `Review ${reviewId} is attached to a document that is not open`,
        );
      }
      return attached;
    }
    return (await this.detachedReviewQueries()).find(
      (query) => query.sidecar.review.reviewId === reviewId,
    );
  }

  public async listReviewQueries(): Promise<ReviewQuery[]> {
    const queries: ReviewQuery[] = [];
    for (const review of this.reviews.listReviews()) {
      const attached = this.attachedReviewQuery(review);
      if (attached === undefined) {
        throw new Error(
          `Review ${review.reviewId} is attached to a document that is not open`,
        );
      }
      queries.push(attached);
    }
    queries.push(...(await this.detachedReviewQueries()));
    return queries;
  }

  /**
   * Commit an editor text update, its suggestion mapping, and its annotation
   * mapping as one transaction. The callback updates the document authority
   * only after the sidecar write succeeds.
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

  /**
   * The same operation for a caller that already holds this document lock.
   *
   * The owner's typing is the one mutation that reaches both halves at once,
   * and it reaches them through the SAME change set, so the persisted
   * anchors and the persisted working text are always the same moment of the
   * document. A document with neither a review nor an annotation has nothing
   * to map, and the edit is simply committed.
   */
  public async applyWorkingTextEditLocked(
    documentId: string,
    workingText: string,
    changes: ChangeSet,
    commitDocument: () => void,
  ): Promise<void> {
    const review = this.reviews.getReview(documentId);
    const annotationState = this.annotationStates.get(documentId);
    if (review === undefined && annotationState === undefined) {
      commitDocument();
      return;
    }

    // Read before commitDocument: the authority still holds the text the
    // owner's changes were made against, which is what a suggestion the edit
    // rewrites has to restore. A review without its document is not a state
    // to map anchors in.
    const textBefore = this.deps.authority.readWorkingText(documentId);
    if (textBefore === undefined) {
      throw new Error(`Document ${documentId} has collaboration state but is not open`);
    }

    const nextWorkingText = normalizeText(workingText);
    const reviewPlan =
      review === undefined
        ? undefined
        : prepareWorkingTextEdit({ review, textBefore, workingText: nextWorkingText, changes });
    const annotationPlan =
      annotationState === undefined
        ? undefined
        : prepareAnnotationMappingThroughOwnerEdit(annotationState.annotations, changes);

    const documentPath = review?.documentPath ?? annotationState!.documentPath;
    await this.sidecars.write(
      this.sidecarFor(documentId, {
        documentPath,
        workingText: nextWorkingText,
        review: reviewPlan?.nextReview ?? review,
        annotations: annotationPlan?.nextAnnotations,
      }),
    );

    commitDocument();
    if (reviewPlan !== undefined) {
      this.reviews.replaceReview(documentId, reviewPlan.nextReview!);
    }
    if (annotationPlan !== undefined) {
      this.commitAnnotations(documentId, {
        ...annotationState!,
        annotations: annotationPlan.nextAnnotations,
      });
    }
    for (const draft of [...(reviewPlan?.events ?? []), ...(annotationPlan?.events ?? [])]) {
      this.deps.emit(draft.event, draft.payload);
    }
    this.deps.authority.broadcastCollaborationState(documentId);
  }

  /**
   * Persist the pending-save fence before the document write begins.
   *
   * A document with annotations and no review prepares too: its fence has to
   * move with the file exactly as a review's does, or the next open reads
   * drift where the owner only pressed save. An open annotation never makes
   * this refuse (I5) — it only decides that the sidecar survives.
   */
  public async prepareSave(
    documentId: string,
    savedSha256: string,
  ): Promise<ReviewSavePreparation | undefined> {
    const review = this.reviews.getReview(documentId);
    const annotationState = this.annotationStates.get(documentId);
    if (review === undefined && annotationState === undefined) {
      return undefined;
    }
    const workingText = this.deps.authority.readWorkingText(documentId);
    if (workingText === undefined) {
      throw new Error(`Document ${documentId} has collaboration state but is not open`);
    }
    const documentPath = review?.documentPath ?? annotationState!.documentPath;
    const unresolvedChunks =
      review === undefined ? 0 : this.reviews.getStatus(documentId, workingText)?.unresolvedChunks ?? 0;
    const keepsAnnotations = (annotationState?.annotations.items.length ?? 0) > 0;
    const survivesSave = unresolvedChunks > 0 || keepsAnnotations;
    if (survivesSave) {
      await this.sidecars.write(
        this.sidecarFor(documentId, {
          documentPath,
          workingText,
          review,
          pendingSave: {
            beforeDiskSha256:
              review?.diskFenceSha256 ?? annotationState!.diskFenceSha256,
            afterDiskSha256: savedSha256,
          },
        }),
      );
    }
    return {
      documentId,
      documentPath,
      reviewId: review?.reviewId,
      workingText,
      survivesSave,
    };
  }

  /**
   * Complete the collaboration half of a successful document save: the fence
   * moves to the bytes now on disk, and the review that no longer has
   * anything unresolved completes.
   *
   * A completed review does NOT delete the sidecar outright. It writes one
   * with no review and the document's annotations, and the store's own
   * survival rule removes the file when that leaves nothing worth keeping.
   */
  public async completeSave(
    preparation: ReviewSavePreparation,
    savedSha256: string,
  ): Promise<void> {
    const review = this.reviews.getReview(preparation.documentId);
    if (preparation.reviewId !== undefined && review?.reviewId !== preparation.reviewId) {
      throw new Error(`Review ${preparation.reviewId} changed during save`);
    }
    const annotations = this.getAnnotations(preparation.documentId);
    const reviewSurvives = preparation.survivesSave && review !== undefined &&
      this.reviews.getStatus(preparation.documentId, preparation.workingText)!.unresolvedChunks > 0;
    const fenced =
      review === undefined || !reviewSurvives
        ? undefined
        : { ...review, diskFenceSha256: savedSha256 };

    await this.sidecars.write(
      this.sidecarFor(preparation.documentId, {
        documentPath: preparation.documentPath,
        workingText: preparation.workingText,
        review: fenced,
        annotations,
        diskFenceSha256: savedSha256,
      }),
    );
    this.commitAnnotations(preparation.documentId, {
      documentPath: preparation.documentPath,
      diskFenceSha256: savedSha256,
      annotations,
    });
    if (fenced !== undefined) {
      this.reviews.replaceReview(preparation.documentId, fenced);
      return;
    }
    if (review === undefined) {
      return;
    }

    this.reviews.removeReview(preparation.documentId);
    this.deps.authority.broadcastReviewCleared(
      preparation.documentId,
      review.reviewId,
    );
    this.deps.emit("review.completed", {
      reviewId: review.reviewId,
      documentId: preparation.documentId,
    });
  }

  /**
   * Persist and drop a document's collaboration state when it detaches. An
   * invalidated review is not written back — its in-process resolution was
   * always destruction — but the annotations of the same document are, so
   * closing a file with a dead review still keeps the owner's comments.
   */
  public async detachCollaboration(documentId: string): Promise<void> {
    const review = this.reviews.getReview(documentId);
    const annotationState = this.annotationStates.get(documentId);
    if (review === undefined && annotationState === undefined) {
      return;
    }
    const documentPath = review?.documentPath ?? annotationState!.documentPath;
    const workingText = this.deps.authority.readWorkingText(documentId);
    if (workingText === undefined) {
      throw new Error(`Document ${documentId} has collaboration state but is not open`);
    }
    await this.sidecars.write(
      this.sidecarFor(documentId, {
        documentPath,
        workingText,
        review: review?.invalidated === true ? undefined : review,
      }),
    );
    this.reviews.removeReview(documentId);
    this.annotationStates.delete(documentId);
  }

  /**
   * Discard dirty editor bytes without fabricating a review projection.
   *
   * The bytes the annotations were measured against are exactly the bytes
   * being thrown away, so their anchors describe nothing that will be on
   * screen a moment from now. I6 says the honest answer to that is
   * `orphaned` and the owner's Reattach — never a search for text that looks
   * like what the comment was about. The threads themselves survive.
   */
  public async discardCollaboration(
    documentId: string,
    documentPath: string,
    diskText: string,
  ): Promise<void> {
    const review = this.reviews.getReview(documentId);
    const persisted = review === undefined
      ? undefined
      : await this.sidecars.read(documentPath);
    const normalizedDisk = normalizeText(diskText);
    const preserveSavedReview =
      review !== undefined &&
      persisted !== undefined &&
      persisted.review !== null &&
      persisted.review.reviewId === review.reviewId &&
      !persisted.review.invalidated &&
      persisted.diskFenceSha256 === sha256Text(normalizedDisk) &&
      persisted.review.suggestions.some((suggestion) => suggestion.state === "proposed");

    if (preserveSavedReview) {
      // The held review's sidecar is left exactly as it is — that is what
      // this branch exists for — but the buffer still reverts underneath the
      // annotations, so their anchors go with it. The persisted object is
      // written back with only its annotation half replaced.
      const plan = prepareAnnotationOrphaning(
        this.getAnnotations(documentId),
        "unmapped-document-change",
      );
      if (plan !== undefined) {
        await this.sidecars.write({ ...persisted!, annotations: plan.nextAnnotations });
        this.commitAnnotations(documentId, {
          ...this.annotationStates.get(documentId)!,
          annotations: plan.nextAnnotations,
        });
        for (const draft of plan.events) {
          this.deps.emit(draft.event, draft.payload);
        }
      }
      return;
    }
    await this.orphanAnnotationsThroughDiscard(documentId, documentPath, normalizedDisk);
    if (review === undefined) {
      return;
    }
    this.reviews.removeReview(documentId);
    this.deps.emit("review.discarded", { reviewId: review.reviewId, documentId });
    this.deps.authority.broadcastReviewCleared(documentId, review.reviewId);
  }

  /**
   * Write the document's annotations back with every anchor orphaned and no
   * review, then commit that. The store deletes the file when a document has
   * neither, so a document with no annotations still ends up with its
   * sidecar gone — which is what this path used to do unconditionally, and
   * why annotations used to disappear with it.
   */
  private async orphanAnnotationsThroughDiscard(
    documentId: string,
    documentPath: string,
    diskText: string,
  ): Promise<void> {
    const annotations = this.getAnnotations(documentId);
    const plan = prepareAnnotationOrphaning(annotations, "unmapped-document-change");
    const next = plan?.nextAnnotations ?? annotations;
    const diskFenceSha256 = sha256Text(diskText);
    await this.sidecars.write(
      collaborationSidecar({
        documentPath,
        workingText: diskText,
        diskFenceSha256,
        review: undefined,
        annotations: next,
      }),
    );
    if (next.items.length === 0) {
      this.annotationStates.delete(documentId);
      return;
    }
    this.commitAnnotations(documentId, { documentPath, diskFenceSha256, annotations: next });
    for (const draft of plan?.events ?? []) {
      this.deps.emit(draft.event, draft.payload);
    }
  }

  /**
   * Read, verify, and attach a detached document's collaboration state.
   *
   * The two halves survive the fence differently. A review that cannot be
   * fenced can never be decided again and is destroyed; annotations that
   * cannot be fenced are still the owner's comments and become `orphaned`
   * instead (I6). That difference is the whole of what this used to get
   * wrong: it deleted the file, and the comments with it.
   */
  public async reattachCollaboration(
    documentId: string,
    documentPath: string,
    diskText: string,
  ): Promise<ReattachedCollaboration | undefined> {
    let sidecar = await this.sidecars.read(documentPath);
    if (sidecar === undefined) {
      return undefined;
    }
    const normalizedDisk = normalizeText(diskText);
    const diskSha256 = sha256Text(normalizedDisk);
    if (sidecar.pendingSave !== undefined) {
      const pendingSave = sidecar.pendingSave;
      const fence =
        diskSha256 === pendingSave.afterDiskSha256
          ? pendingSave.afterDiskSha256
          : diskSha256 === pendingSave.beforeDiskSha256
            ? pendingSave.beforeDiskSha256
            : undefined;
      if (fence === undefined) {
        return await this.driftedCollaboration(documentId, documentPath, sidecar, diskSha256);
      }
      sidecar = { ...sidecar, diskFenceSha256: fence };
      delete sidecar.pendingSave;
      await this.sidecars.write(sidecar);
    } else if (diskSha256 !== sidecar.diskFenceSha256) {
      return await this.driftedCollaboration(documentId, documentPath, sidecar, diskSha256);
    }

    const hasOutstandingReview =
      sidecar.review !== null &&
      sidecar.review.suggestions.some((suggestion) => suggestion.state === "proposed");

    // Without a review to restore, the persisted working text has no claim
    // on the buffer: the buffer is the file. If the two disagree, the
    // anchors were measured against text nobody is looking at, and there is
    // no change set to carry them across the difference.
    const annotations = hasOutstandingReview || sidecar.workingText === normalizedDisk
      ? sidecar.annotations
      : prepareAnnotationOrphaning(sidecar.annotations, "unmapped-document-change")
          ?.nextAnnotations ?? sidecar.annotations;

    const review = hasOutstandingReview
      ? reviewFromSidecar(documentId, sidecar)
      : undefined;
    const workingText = hasOutstandingReview ? sidecar.workingText : normalizedDisk;

    // A file that already says exactly this is left alone; the orphaning
    // above and a review that did not survive are the two things that make
    // it stale. The store deletes it when neither half is left.
    if (annotations !== sidecar.annotations || (sidecar.review !== null && review === undefined)) {
      await this.sidecars.write(
        collaborationSidecar({
          documentPath,
          workingText,
          diskFenceSha256: sidecar.diskFenceSha256,
          review,
          annotations,
        }),
      );
    }
    if (review !== undefined) {
      this.reviews.replaceReview(documentId, review);
    }
    if (annotations.items.length > 0) {
      this.commitAnnotations(documentId, {
        documentPath,
        diskFenceSha256: sidecar.diskFenceSha256,
        annotations,
      });
    }
    if (review === undefined && annotations.items.length === 0) {
      return undefined;
    }
    this.deps.authority.broadcastCollaborationState(documentId);
    return { review, annotations, workingText: review === undefined ? undefined : workingText };
  }

  /**
   * The file moved under a sidecar that was not open to see it. The review is
   * destroyed and announced; the annotations are orphaned, refenced to the
   * bytes that are actually there, and kept.
   */
  private async driftedCollaboration(
    documentId: string,
    documentPath: string,
    sidecar: CollaborationSidecarData,
    diskSha256: string,
  ): Promise<ReattachedCollaboration | undefined> {
    const annotations =
      prepareAnnotationOrphaning(sidecar.annotations, "external-drift")?.nextAnnotations ??
      sidecar.annotations;
    await this.sidecars.write(
      collaborationSidecar({
        documentPath,
        workingText: sidecar.workingText,
        diskFenceSha256: diskSha256,
        review: undefined,
        annotations,
      }),
    );
    this.deps.warn(
      `Review ${sidecar.review?.reviewId ?? "(unknown)"} for ${documentPath} was discarded after disk drift.`,
    );
    this.deps.emit("review.invalidated", {
      reviewId: sidecar.review?.reviewId ?? "",
      documentId,
    });
    if (annotations.items.length === 0) {
      return undefined;
    }
    this.commitAnnotations(documentId, {
      documentPath,
      diskFenceSha256: diskSha256,
      annotations,
    });
    this.deps.authority.broadcastCollaborationState(documentId);
    return { review: undefined, annotations, workingText: undefined };
  }

  public readSidecar(documentPath: string): Promise<CollaborationSidecarData | undefined> {
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
  public withDocumentLock<T>(
    documentId: string,
    run: () => Promise<T>,
  ): Promise<T> {
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

    // Every review mutation that moves document bytes moves them under the
    // annotations too, and it is the SAME change set that has to carry them.
    // Applying a proposal, rejecting one, retracting a packet, and clearing
    // a review are all this one case, which is why none of them names
    // annotations anywhere: the anchors follow the text, in this
    // transaction, or the transaction does not happen.
    const annotationState = this.annotationStates.get(context.documentId);
    const annotationPlan =
      prepared.change === undefined || annotationState === undefined
        ? undefined
        : prepareAnnotationMappingThroughOwnerEdit(
            annotationState.annotations,
            prepared.change.changes,
          );

    try {
      await this.sidecars.write(
        this.sidecarFor(context.documentId, {
          documentPath: context.documentPath,
          workingText: plan.nextWorkingText,
          review: plan.nextReview,
          annotations: annotationPlan?.nextAnnotations,
        }),
      );
    } catch (error) {
      return persistenceFailure("the mutation", error);
    }

    if (plan.nextReview === undefined) {
      this.reviews.removeReview(context.documentId);
    } else {
      this.reviews.replaceReview(context.documentId, plan.nextReview);
    }
    if (annotationPlan !== undefined) {
      this.commitAnnotations(context.documentId, {
        ...annotationState!,
        annotations: annotationPlan.nextAnnotations,
      });
    }
    this.deps.authority.commitWorkingTextReplacement(prepared);

    for (const draft of [...plan.events, ...(annotationPlan?.events ?? [])]) {
      this.deps.emit(draft.event, draft.payload);
    }
    if (broadcast === "cleared") {
      this.deps.authority.broadcastReviewCleared(
        context.documentId,
        context.review.reviewId,
      );
    } else if (plan.nextReview !== undefined) {
      this.deps.authority.broadcastCollaborationState(context.documentId);
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
  private async checkDiskFence(
    context: MutationContext,
  ): Promise<{ ok: true } | ReviewFailure> {
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
    // The annotations are NOT orphaned here. The buffer is untouched and the
    // document stays open, so every anchor still points at the text it
    // always did; what moved is the file the review was fenced against.
    // Orphaning waits for the reload that actually replaces the bytes.
    try {
      await this.sidecars.write(
        this.sidecarFor(context.documentId, {
          documentPath: context.documentPath,
          workingText: context.workingText,
          review: invalidated,
        }),
      );
    } catch (error) {
      return persistenceFailure("the drift invalidation", error);
    }
    this.reviews.replaceReview(context.documentId, invalidated);
    this.deps.emit("review.invalidated", {
      reviewId: invalidated.reviewId,
      documentId: context.documentId,
    });
    this.deps.authority.broadcastReviewCleared(
      context.documentId,
      invalidated.reviewId,
    );
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

    // The claim sequence and the packet list are index-aligned, so claim k's
    // addressed annotations belong to packet k. Linkage is prepared here,
    // after the review plan, because packet ids do not exist before it; that
    // costs nothing, because both plans are values and the single write
    // below is the only thing that can make either of them true.
    const annotationState = this.annotationStates.get(input.documentId);
    const mapped =
      prepared.change === undefined || annotationState === undefined
        ? undefined
        : prepareAnnotationMappingThroughOwnerEdit(
            annotationState.annotations,
            prepared.change.changes,
          );
    const linkage = prepareAnnotationProposalLinkage({
      annotations: mapped?.nextAnnotations ?? annotationState?.annotations ?? emptyAnnotationSet(),
      reviewId: plan.nextReview!.reviewId,
      links: plan.response.packetIds.map((packetId, index) => ({
        packetId,
        annotationIds: input.claims[index]?.addressesAnnotationIds ?? [],
      })),
    });
    if (linkage !== undefined && isTransitionError(linkage)) {
      return { ok: false, code: linkage.code, message: linkage.message };
    }
    const nextAnnotations = linkage?.nextAnnotations ?? mapped?.nextAnnotations;

    try {
      await this.sidecars.write(
        this.sidecarFor(input.documentId, {
          documentPath,
          workingText: plan.nextWorkingText,
          review: plan.nextReview,
          annotations: nextAnnotations,
        }),
      );
    } catch (error) {
      return persistenceFailure("the proposal", error);
    }
    this.reviews.replaceReview(input.documentId, plan.nextReview!);
    if (nextAnnotations !== undefined && annotationState !== undefined) {
      this.commitAnnotations(input.documentId, {
        ...annotationState,
        annotations: nextAnnotations,
      });
    }
    this.deps.authority.commitWorkingTextReplacement(prepared);
    for (const draft of [
      ...plan.events,
      ...(mapped?.events ?? []),
      ...(linkage?.events ?? []),
    ]) {
      this.deps.emit(draft.event, draft.payload);
    }
    this.deps.authority.broadcastCollaborationState(input.documentId);
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
      return this.commitReviewMutation(context, () => {
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
            this.deps.warn(
              `Chunk decision refused for ${context.documentPath}: ${plan.message}`,
            );
            this.deps.authority.broadcastCollaborationState(context.documentId);
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
        () =>
          prepareClear({ review: context.review, workingText: context.workingText }),
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
    | RetractProposalResponse
    | (ReviewFailure & { reviewId: string; canClearUnresolved: boolean })
  > {
    // Reviews and their packets are few; a scan is cheaper to keep correct
    // than an index every mutation must remember to maintain.
    const owner = this.reviews
      .listReviews()
      .find((candidate) =>
        candidate.packets.some((packet) => packet.packetId === packetId),
      );
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

  // ==========================================================================
  // Annotation operations
  // ==========================================================================

  /**
   * The one ordering every annotation mutation obeys, and the twin of
   * commitReviewMutation above.
   *
   * `prepare` is pure and may refuse; a refusal reaches the caller having
   * touched nothing, because the only thing that can make a plan true is the
   * write below it. The committed set is replaced only after that write
   * returns, which is invariant I2: no annotation is visible in memory that
   * is not already on disk.
   *
   * The review is read here and written back UNCHANGED, so a document that
   * is under review keeps it across an annotation mutation. That is the
   * other half of one sidecar, one write.
   */
  private async commitAnnotationMutation<Response>(
    documentId: string,
    prepare: (context: {
      documentPath: string;
      workingText: string;
      annotations: AnnotationSet;
    }) => AnnotationMutationPlan<Response> | AnnotationTransitionError,
  ): Promise<Response | AnnotationFailure> {
    return await this.withDocumentLock(documentId, async () => {
      const documentPath = this.deps.authority.resolveDocumentPath(documentId);
      const workingText = this.deps.authority.readWorkingText(documentId);
      if (documentPath === undefined || workingText === undefined) {
        return {
          ok: false as const,
          code: "DOCUMENT_CLOSED" as const,
          message: "The annotated document is no longer open.",
        };
      }
      const normalized = normalizeText(workingText);
      const state = this.annotationStates.get(documentId);
      const plan = prepare({
        documentPath,
        workingText: normalized,
        annotations: state?.annotations ?? emptyAnnotationSet(),
      });
      if (isTransitionError(plan)) {
        return { ok: false as const, code: plan.code, message: plan.message };
      }

      const review = this.reviews.getReview(documentId);
      const diskFenceSha256 =
        state?.diskFenceSha256 ??
        review?.diskFenceSha256 ??
        sha256Text(normalizeText(await this.deps.authority.readDiskText(documentPath)));

      try {
        await this.sidecars.write(
          this.sidecarFor(documentId, {
            documentPath,
            workingText: normalized,
            review,
            annotations: plan.nextAnnotations,
            diskFenceSha256,
          }),
        );
      } catch (error) {
        return persistenceFailure("the annotation change", error);
      }

      // The entry stays even when the last annotation goes: the generation a
      // client just read has to keep meaning what it meant, and a counter
      // that restarted at zero would answer a stale fence as a fresh one.
      // Closing the document is what retires it.
      this.commitAnnotations(documentId, {
        documentPath,
        diskFenceSha256,
        annotations: plan.nextAnnotations,
      });
      for (const draft of plan.events) {
        this.deps.emit(draft.event, draft.payload);
      }
      this.deps.authority.broadcastCollaborationState(documentId);
      return plan.response;
    });
  }

  /** The owner comments on a stretch of the document. */
  public async createAnnotation(input: {
    documentId: string;
    actor: AnnotationActor;
    from: number;
    to: number;
    instruction: string;
    expectedAnnotationGeneration: number;
  }): Promise<TextAnnotation | AnnotationFailure> {
    return await this.commitAnnotationMutation(input.documentId, (context) =>
      prepareAnnotationCreation({
        annotations: context.annotations,
        actor: input.actor,
        documentId: input.documentId,
        workingText: context.workingText,
        from: input.from,
        to: input.to,
        instruction: input.instruction,
        expectedAnnotationGeneration: input.expectedAnnotationGeneration,
      }),
    );
  }

  /** One more turn of a thread, from either side. */
  public async addAnnotationMessage(input: {
    documentId: string;
    annotationId: string;
    actor: AnnotationActor;
    text: string;
    clientRequestId?: string;
    expectedAnnotationGeneration: number;
  }): Promise<AnnotationMessage | AnnotationFailure> {
    return await this.commitAnnotationMutation(input.documentId, (context) =>
      prepareAnnotationMessage({
        annotations: context.annotations,
        actor: input.actor,
        annotationId: input.annotationId,
        text: input.text,
        clientRequestId: input.clientRequestId,
        expectedAnnotationGeneration: input.expectedAnnotationGeneration,
      }),
    );
  }

  public async resolveAnnotation(input: {
    documentId: string;
    annotationId: string;
    actor: AnnotationActor;
    expectedAnnotationGeneration: number;
  }): Promise<TextAnnotation | AnnotationFailure> {
    return await this.commitAnnotationMutation(input.documentId, (context) =>
      prepareAnnotationResolution({ ...input, annotations: context.annotations }),
    );
  }

  public async reopenAnnotation(input: {
    documentId: string;
    annotationId: string;
    actor: AnnotationActor;
    expectedAnnotationGeneration: number;
  }): Promise<TextAnnotation | AnnotationFailure> {
    return await this.commitAnnotationMutation(input.documentId, (context) =>
      prepareAnnotationReopen({ ...input, annotations: context.annotations }),
    );
  }

  public async deleteAnnotation(input: {
    documentId: string;
    annotationId: string;
    actor: AnnotationActor;
    expectedAnnotationGeneration: number;
  }): Promise<TextAnnotation | AnnotationFailure> {
    return await this.commitAnnotationMutation(input.documentId, (context) =>
      prepareAnnotationDeletion({ ...input, annotations: context.annotations }),
    );
  }

  /** The owner points an orphaned or collapsed anchor at a new range. */
  public async reattachAnnotation(input: {
    documentId: string;
    annotationId: string;
    actor: AnnotationActor;
    from: number;
    to: number;
    expectedAnnotationGeneration: number;
  }): Promise<TextAnnotation | AnnotationFailure> {
    return await this.commitAnnotationMutation(input.documentId, (context) =>
      prepareAnnotationReattachment({
        annotations: context.annotations,
        actor: input.actor,
        annotationId: input.annotationId,
        from: input.from,
        to: input.to,
        workingText: context.workingText,
        expectedAnnotationGeneration: input.expectedAnnotationGeneration,
      }),
    );
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
