/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiffStore behavioral tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the provider-owned ReviewDiffStore: packet
 *                  composition, chunk decisions by content-addressed id,
 *                  clearing, retraction, idempotency, and composite diff
 *                  computation.
 *
 *                  The store holds only the merge reference; the working text
 *                  is the live document, read through the resolver the store
 *                  is constructed with. This suite therefore plays the
 *                  document authority: `documents` is the authoritative text
 *                  per documentId, and every store result carrying a
 *                  workingText is applied back to it — the same obligation
 *                  DocumentManager discharges in production.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { createPatch } from "diff";
import EventEmitter from "events";
import type { AgentEvent } from "@dts/common/agent-api";
import type { ChunkDecision } from "@providers/documents/review-transitions";
import type { ActiveReviewState } from "@dts/common/review-domain";
import {
  proposalRequestFingerprint,
  ReviewDiffStore,
  reviewFromSidecar,
  reviewSidecar,
  type ReviewSidecarData,
} from "source/app/service-providers/documents/review-diff-store";
import { sha256Text } from "source/common/util/sha256";
import {
  isTransitionError,
  prepareAcceptAll,
  prepareChunkDecision,
  prepareClear,
  prepareProposalSubmission,
  prepareRetraction,
  prepareReviewComment,
  prepareWorkingTextEdit,
  validateAndParsePatch,
  type ClaimInput,
  type ReviewMutationPlan,
  type ReviewTransitionError,
} from "source/app/service-providers/documents/review-transitions";

const DOC_ID = "doc-test";
const DOC_PATH = "/home/user/note.md";

/**
 * The application layer, as a test double: read the committed review and the
 * live text, prepare a pure transition, then commit its plan — store, then
 * document, then events. DocumentManager discharges exactly this obligation
 * in production, and Phase 7's review application service will own it.
 *
 * The method names mirror the mutations the API exposes, so the suite reads
 * as review behaviour rather than as plumbing.
 */
class ReviewDriver {
  readonly store = new ReviewDiffStore();
  readonly events = new EventEmitter();

  constructor(private readonly documents: Map<string, string>) {}

  private workingTextOf(documentId: string): string {
    const text = this.documents.get(documentId);
    if (text === undefined) {
      throw new Error(`Document ${documentId} is not open`);
    }
    return text;
  }

  private commit(documentId: string, plan: ReviewMutationPlan<unknown>): void {
    if (plan.nextReview === undefined) {
      this.store.removeReview(documentId);
    } else {
      this.store.replaceReview(documentId, plan.nextReview);
    }
    this.documents.set(documentId, plan.nextWorkingText);
    for (const draft of plan.events) {
      const { generation, ...rest } = draft.payload;
      this.events.emit(draft.event, {
        event: draft.event,
        timestamp: new Date().toISOString(),
        ...rest,
        reviewGeneration: generation,
      });
    }
  }

  /** Subscribe to committed review events, as the HTTP layer does. */
  on(event: string, listener: (event: AgentEvent) => void): void {
    this.events.on(event, listener as (...args: unknown[]) => void);
  }

  getReview(documentId: string): ActiveReviewState | undefined {
    return this.store.getReview(documentId);
  }

  listReviews(): Array<{ reviewId: string; state: string }> {
    return this.store.listReviews().flatMap((review) => {
      const status = this.store.getStatus(
        review.documentId,
        this.workingTextOf(review.documentId),
      );
      return status === undefined ? [] : [status];
    });
  }

  getReviewStatus(documentId: string) {
    return this.store.getStatus(documentId, this.workingTextOf(documentId));
  }

  getOutstandingChunks(documentId: string) {
    return this.store.getOutstandingChunks(
      documentId,
      this.workingTextOf(documentId),
    );
  }

  getReviewDiff(documentId: string): string | undefined {
    return this.store.getReviewDiff(documentId, this.workingTextOf(documentId));
  }

  countUnresolved(documentId: string): number {
    return this.getReviewStatus(documentId)?.unresolvedChunks ?? 0;
  }

  countHeld(documentId: string): number {
    return this.getReviewStatus(documentId)?.heldChunks ?? 0;
  }

  /**
   * Open an EMPTY review — the state a document is in between "a review
   * exists here" and "a claim has landed". Production never constructs one:
   * prepareProposalSubmission opens the review with its first packets, so
   * a refused batch leaves no empty review behind.
   */
  openReview(options: {
    documentId: string;
    documentPath: string;
    baselineText: string;
    diskBaselineSha256: string;
  }): void {
    if (this.store.getReview(options.documentId) !== undefined) {
      throw new Error(
        `A review is already active for document ${options.documentId}`,
      );
    }
    this.store.replaceReview(options.documentId, {
      reviewId: `review-${options.documentId}-${this.store.listReviews().length}`,
      documentId: options.documentId,
      documentPath: options.documentPath,
      referenceText: options.baselineText,
      generation: 0,
      packets: [],
      submissions: [],
      holds: [],
      comments: [],
      diskFenceSha256: options.diskBaselineSha256,
      invalidated: false,
    });
  }

  submitClaims(
    documentId: string,
    options: {
      claims: ClaimInput[];
      clientRequestId: string;
      expectedReviewGeneration?: number;
    },
  ):
    | {
        ok: true;
        packetIds: string[];
        reviewId: string;
        generation: number;
        workingText: string;
        unresolvedChunks: number;
        state: string;
      }
    | ReviewTransitionError {
    const review = this.store.getReview(documentId);
    if (review === undefined) {
      return {
        ok: false,
        code: "REVIEW_NOT_FOUND",
        message: "No active review for this document.",
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
    const workingText = this.workingTextOf(documentId);
    const plan = prepareProposalSubmission({
      review,
      documentId,
      documentPath: review.documentPath,
      workingText,
      diskSha256: review.diskFenceSha256,
      claims: options.claims,
      clientRequestId: options.clientRequestId,
      requestFingerprint: proposalRequestFingerprint({
        documentId,
        baselineSha256: sha256Text(workingText),
        expectedReviewGeneration: options.expectedReviewGeneration ?? 0,
        claims: options.claims,
      }),
    });
    if (isTransitionError(plan)) {
      return plan;
    }
    this.commit(documentId, plan);
    return {
      ok: true,
      packetIds: plan.response.packetIds,
      reviewId: plan.response.reviewId,
      generation: plan.response.reviewGeneration,
      workingText: plan.nextWorkingText,
      unresolvedChunks: plan.response.unresolvedChunks,
      state: plan.response.state,
    };
  }

  decideChunk(
    documentId: string,
    reviewId: string,
    chunkId: string,
    decision: ChunkDecision,
    comment?: string,
  ) {
    const review = this.store.getReview(documentId);
    if (review === undefined || review.reviewId !== reviewId) {
      return {
        ok: false as const,
        code: "REVIEW_NOT_FOUND" as const,
        message: "No active review for this document.",
      };
    }
    const before = this.workingTextOf(documentId);
    const plan = prepareChunkDecision({
      review,
      workingText: before,
      chunkId,
      decision,
      comment,
    });
    if (isTransitionError(plan)) {
      return plan;
    }
    this.commit(documentId, plan);
    return {
      ...plan.response,
      generation: plan.response.reviewGeneration,
      // Accept and hold move no document bytes; the suite applies only what
      // actually changed, exactly as the document authority does.
      workingText:
        plan.nextWorkingText === before ? undefined : plan.nextWorkingText,
    };
  }

  acceptAllChunks(documentId: string) {
    const review = this.store.getReview(documentId);
    if (review === undefined) {
      return {
        ok: false as const,
        code: "REVIEW_NOT_FOUND" as const,
        message: "No active review for this document.",
      };
    }
    const plan = prepareAcceptAll({
      review,
      workingText: this.workingTextOf(documentId),
    });
    if (isTransitionError(plan)) {
      return plan;
    }
    this.commit(documentId, plan);
    return { ...plan.response, generation: plan.response.reviewGeneration };
  }

  clearUnresolved(documentId: string) {
    const review = this.store.getReview(documentId);
    if (review === undefined) {
      return {
        ok: false as const,
        code: "REVIEW_NOT_FOUND" as const,
        message: "No active review for this document.",
      };
    }
    const plan = prepareClear({
      review,
      workingText: this.workingTextOf(documentId),
    });
    this.commit(documentId, plan);
    return {
      ...plan.response,
      generation: plan.response.reviewGeneration,
      workingText: plan.nextWorkingText,
      referenceText: plan.nextReview!.referenceText,
    };
  }

  addReviewComment(documentId: string, text: string) {
    const review = this.store.getReview(documentId);
    if (review === undefined) {
      return {
        ok: false as const,
        code: "REVIEW_NOT_FOUND" as const,
        message: "No active review for this document.",
      };
    }
    const plan = prepareReviewComment({
      review,
      workingText: this.workingTextOf(documentId),
      text,
    });
    this.commit(documentId, plan);
    return { ...plan.response, generation: plan.response.reviewGeneration };
  }

  retractPacket(packetId: string) {
    const review = this.store
      .listReviews()
      .find((candidate) =>
        candidate.packets.some((packet) => packet.packetId === packetId),
      );
    if (review === undefined) {
      return {
        ok: false as const,
        code: "PACKET_NOT_RETRACTABLE" as const,
        message: "The packet was not found.",
        reviewId: "",
        canClearUnresolved: true as const,
      };
    }
    const plan = prepareRetraction({
      review,
      workingText: this.workingTextOf(review.documentId),
      packetId,
    });
    if (isTransitionError(plan)) {
      return plan;
    }
    this.commit(review.documentId, plan);
    return {
      ...plan.response,
      generation: plan.response.reviewGeneration,
      workingText: plan.nextWorkingText,
    };
  }

  /** The editor typed: reconcile holds against the new partition. */
  reportWorkingTextEdit(documentId: string): void {
    const review = this.store.getReview(documentId);
    if (review === undefined) {
      return;
    }
    const plan = prepareWorkingTextEdit({
      review,
      workingText: this.workingTextOf(documentId),
    });
    if (plan !== undefined) {
      this.commit(documentId, plan);
    }
  }

  invalidateReview(documentId: string): void {
    const review = this.store.getReview(documentId);
    if (review !== undefined) {
      this.store.replaceReview(documentId, { ...review, invalidated: true });
    }
  }

  closeReview(documentId: string): void {
    this.store.removeReview(documentId);
  }

  completeReview(documentId: string): void {
    this.store.removeReview(documentId);
  }

  exportReviewSidecar(documentId: string): ReviewSidecarData | undefined {
    const review = this.store.getReview(documentId);
    return review === undefined
      ? undefined
      : reviewSidecar(review, this.workingTextOf(documentId));
  }

  restoreReview(documentId: string, sidecar: ReviewSidecarData): ActiveReviewState {
    const restored = reviewFromSidecar(documentId, sidecar);
    this.store.replaceReview(documentId, restored);
    return restored;
  }
}

function makePatch(oldText: string, newText: string): string {
  return createPatch(DOC_PATH, oldText, newText, "", "", { context: 3 });
}

function makeGenericHeaderPatch(oldText: string, newText: string): string {
  const patch = createPatch(DOC_PATH, oldText, newText, "", "", { context: 3 });
  // Replace the path headers with the generic "document" header
  return patch
    .replace(`--- ${DOC_PATH}`, "--- document")
    .replace(`+++ ${DOC_PATH}`, "+++ document");
}

describe("review transitions over committed review state", function () {
  let driver: ReviewDriver;
  /** The authoritative document text per documentId — the suite is the document owner. */
  let documents: Map<string, string>;

  beforeEach(function () {
    documents = new Map();
    driver = new ReviewDriver(documents);
  });

  const submitClaims = (
    documentId: string,
    options: {
      claims: ClaimInput[];
      clientRequestId: string;
      expectedReviewGeneration?: number;
    },
  ) => driver.submitClaims(documentId, options);

  /**
   * The document authority took new text — a user keystroke, or the text a
   * transition just returned. Reporting it is not optional bookkeeping: a
   * read is a pure projection of committed state, so an edit that retires a
   * held chunk's id is reconciled here or not at all. DocumentManager does
   * exactly this from its authority-update path.
   */
  function setDocumentText(documentId: string, text: string): void {
    documents.set(documentId, text);
    driver.reportWorkingTextEdit(documentId);
  }

  /** The one-claim case, with the newest packetId surfaced for assertions. */
  function submitOne(
    documentId: string,
    options: {
      patch: string;
      description?: string;
      clientRequestId: string;
      expectedReviewGeneration?: number;
    },
  ) {
    const result = submitClaims(documentId, {
      claims: [
        { patch: options.patch, description: options.description ?? "a claim" },
      ],
      clientRequestId: options.clientRequestId,
      expectedReviewGeneration: options.expectedReviewGeneration,
    });
    return result.ok ? { ...result, packetId: result.packetIds[0] } : result;
  }

  /**
   * Open a review the way DocumentManager does: text into the doc, open the
   * (empty) review, then submit the first packet through the one application
   * path. Throws on a refused initial packet, mirroring the manager's
   * dry-run-then-open contract of never leaving an empty review behind.
   */
  function openReview(
    documentId: string,
    baseline: string,
    initialPatch?: { patch: string; clientRequestId: string; description?: string },
  ): void {
    setDocumentText(documentId, baseline);
    driver.openReview({
      documentId,
      documentPath: DOC_PATH,
      baselineText: baseline,
      diskBaselineSha256: sha256Text(baseline),
    });
    if (initialPatch !== undefined) {
      const submitted = submitOne(documentId, {
        patch: initialPatch.patch,
        clientRequestId: initialPatch.clientRequestId,
        description: initialPatch.description,
      });
      if (!submitted.ok) {
        driver.closeReview(documentId);
        throw new Error(submitted.message);
      }
      // The caller's obligation: the returned working text becomes the document.
      setDocumentText(documentId, submitted.workingText);
    }
  }

  /** Decide the sole outstanding chunk, applying any returned working text. */
  function decideOnlyChunk(decision: "accept" | "reject") {
    const chunks = driver.getOutstandingChunks(DOC_ID);
    assert.ok(chunks !== undefined && chunks.length === 1, "expected exactly one chunk");
    const result = driver.decideChunk(
      DOC_ID,
      driver.getReview(DOC_ID)!.reviewId,
      chunks[0].chunkId,
      decision,
    );
    assert.equal(result.ok, true, `decision failed: ${JSON.stringify(result)}`);
    if (result.ok && result.workingText !== undefined) {
      setDocumentText(DOC_ID, result.workingText);
    }
    return result;
  }

  describe("openReview", function () {
    it("opens a review whose reference is the baseline", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline);
      const review = driver.getReview(DOC_ID)!;
      assert.equal(review.referenceText, baseline);
      assert.equal(review.generation, 0);
      assert.equal(review.packets.length, 0);
      assert.equal(review.diskFenceSha256, sha256Text(baseline));
      assert.equal(driver.countUnresolved(DOC_ID), 0);
    });

    it("opens a review with an initial patch as the first packet", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const review = driver.getReview(DOC_ID)!;
      assert.equal(documents.get(DOC_ID), proposed);
      assert.equal(review.referenceText, baseline);
      assert.equal(review.generation, 1);
      assert.equal(review.packets.length, 1);
      assert.equal(review.packets[0].clientRequestId, "req-1");
      assert.equal(driver.countUnresolved(DOC_ID), 1);
    });

    it("throws if a review is already active for the document", function () {
      openReview(DOC_ID, "alpha\n");
      assert.throws(() => {
        driver.openReview({
          documentId: DOC_ID,
          documentPath: DOC_PATH,
          baselineText: "alpha\n",
          diskBaselineSha256: sha256Text("alpha\n"),
        });
      }, /already active/);
    });

    it("throws if the initial patch does not change the document", function () {
      const baseline = "alpha\n";
      assert.throws(() => {
        openReview(DOC_ID, baseline, {
          patch: makePatch(baseline, baseline),
          clientRequestId: "req-1",
        });
      }, /does not change/);
    });
  });

  describe("single-claim submission", function () {
    it("applies a second packet to the live document text while preserving unresolved chunks", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const first = "alpha\nBETA\ngamma\n";
      const second = "ALPHA\nBETA\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, first),
        clientRequestId: "req-1",
      });
      const result = submitOne(DOC_ID, {
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      assert.equal(result.workingText, second);
      setDocumentText(DOC_ID, result.workingText);
      // Both changes are on adjacent lines, so the engine reports one chunk:
      // alpha→ALPHA + beta→BETA
      assert.equal(result.unresolvedChunks, 1);
    });

    it("stamps every packet with the fingerprint of the request that applied it", function () {
      // Idempotency is the ledger's job, not the store's: the store holds
      // what was committed, and the submission transition records both the
      // packets and the ledger entry that answers a replayed request in the
      // same candidate state — so neither can commit without the other.
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const review = driver.getReview(DOC_ID)!;
      assert.equal(review.packets[0].clientRequestId, "req-1");
      assert.match(review.packets[0].requestFingerprint, /^[0-9a-f]{64}$/);
      assert.equal(review.submissions.length, 1);
      assert.equal(review.submissions[0].clientRequestId, "req-1");
      assert.equal(
        review.submissions[0].requestFingerprint,
        review.packets[0].requestFingerprint,
      );
      assert.deepEqual(review.submissions[0].packetIds, [
        review.packets[0].packetId,
      ]);
    });

    it("fingerprints requests that differ only inside a claim differently", function () {
      const baseline = "alpha\n";
      const shared = {
        documentId: DOC_ID,
        baselineSha256: sha256Text(baseline),
        expectedReviewGeneration: 0,
      };
      const patch = makePatch(baseline, "ALPHA\n");
      assert.notEqual(
        proposalRequestFingerprint({
          ...shared,
          claims: [{ description: "caps", patch }],
        }),
        proposalRequestFingerprint({
          ...shared,
          claims: [{ description: "lowers", patch }],
        }),
      );
      // Key order inside a claim is the client's, not part of its identity.
      assert.equal(
        proposalRequestFingerprint({
          ...shared,
          claims: [{ description: "caps", patch }],
        }),
        proposalRequestFingerprint({
          ...shared,
          claims: [{ patch, description: "caps" } as ClaimInput],
        }),
      );
    });

    it("rejects a packet that leaves the working text unchanged, as openReview does", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      // A hunk that replaces a line with itself. validateAndParsePatch only
      // rejects a patch with no hunks at all, and this one applies cleanly at
      // zero fuzz — so nothing upstream of submitProposal catches it.
      const noOp = [
        "--- document",
        "+++ document",
        "@@ -2,1 +2,1 @@",
        "-BETA",
        "+BETA",
        "",
      ].join("\n");
      const result = submitOne(DOC_ID, {
        patch: noOp,
        clientRequestId: "req-noop",
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PATCH_INVALID");
      // A rejected no-op must not have advanced the review: a burnt generation
      // makes the no-op the newest packet and blocks retracting the real one.
      const review = driver.getReview(DOC_ID);
      assert.ok(review !== undefined);
      assert.equal(review.generation, 1);
      assert.equal(documents.get(DOC_ID), proposed);
    });

    it("rejects with REVISION_MISMATCH when expectedReviewGeneration does not match", function () {
      const baseline = "alpha\n";
      openReview(DOC_ID, baseline);
      const result = submitOne(DOC_ID, {
        patch: makePatch(baseline, "beta\n"),
        clientRequestId: "req-1",
        expectedReviewGeneration: 99,
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "REVISION_MISMATCH");
    });

    it("rejects with REVIEW_NOT_FOUND when no review is active", function () {
      const result = submitOne("doc-missing", {
        patch: makePatch("a\n", "b\n"),
        clientRequestId: "req-1",
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "REVIEW_NOT_FOUND");
    });

    it("rejects with PATCH_NOT_APPLICABLE when the patch does not apply with zero fuzz", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline);
      // A patch built against a completely different text
      const result = submitOne(DOC_ID, {
        patch: makePatch("completely\ndifferent\ntext\n", "something\nelse\n"),
        clientRequestId: "req-1",
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PATCH_NOT_APPLICABLE");
    });
  });

  describe("submitClaims", function () {
    it("applies an ordered sequence, one packet per claim, sequentially", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      openReview(DOC_ID, baseline);
      // Claim 2's patch is built against claim 1's output: it can only apply
      // if the sequence really is sequential.
      const afterFirst = "alpha\nBETA\ngamma\n";
      const afterSecond = "alpha\nBETA\nGAMMA\n";
      const result = submitClaims(DOC_ID, {
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "Capitalize beta" },
          { patch: makePatch(afterFirst, afterSecond), description: "Capitalize gamma" },
        ],
        clientRequestId: "batch-1",
      });
      assert.equal(result.ok, true, `batch failed: ${JSON.stringify(result)}`);
      if (!result.ok) {return;}
      setDocumentText(DOC_ID, result.workingText);

      assert.equal(result.workingText, afterSecond);
      assert.equal(result.packetIds.length, 2);
      const review = driver.getReview(DOC_ID)!;
      assert.equal(review.generation, 2);
      assert.deepEqual(
        review.packets.map((p) => p.packetId),
        result.packetIds,
      );
      assert.deepEqual(
        review.packets.map((p) => p.description),
        ["Capitalize beta", "Capitalize gamma"],
      );
      assert.deepEqual(
        review.packets.map((p) => p.applicationGeneration),
        [1, 2],
      );
    });

    it("answers a replayed clientRequestId from the review's own ledger", function () {
      // The store applies; the ledger decides. A replay is looked up in the
      // review's submissions — which is why it survives detach and restart
      // for as long as the review does, and stops the moment it does not.
      const baseline = "alpha\nbeta\ngamma\n";
      const afterFirst = "ALPHA\nbeta\ngamma\n";
      const afterSecond = "ALPHA\nbeta\nGAMMA\n";
      openReview(DOC_ID, baseline);
      const options = {
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "first" },
          { patch: makePatch(afterFirst, afterSecond), description: "second" },
        ],
        clientRequestId: "batch-replay",
        expectedReviewGeneration: 0,
      };

      const committed = submitClaims(DOC_ID, options);
      assert.ok(
        committed.ok,
        `the initial batch must commit before replay: ${JSON.stringify(committed)}`,
      );
      const review = driver.getReview(DOC_ID)!;

      const prior = review.submissions.find(
        (submission) => submission.clientRequestId === options.clientRequestId,
      );
      assert.ok(prior !== undefined, "the ledger must carry the committed submission");
      assert.deepEqual(prior.packetIds, committed.packetIds);
      assert.equal(prior.response.reviewGeneration, committed.generation);
      assert.equal(prior.response.unresolvedChunks, committed.unresolvedChunks);
      // Every packet of one submission shares that submission's fingerprint,
      // so a replayed id is compared against the request that produced them.
      assert.deepEqual(
        review.packets.map((packet) => packet.requestFingerprint),
        [prior.requestFingerprint, prior.requestFingerprint],
      );
      assert.equal(review.generation, 2);
      assert.deepEqual(
        review.packets.map((packet) => packet.packetId),
        committed.packetIds,
      );
    });

    it("is all-or-nothing: a failing claim leaves the review untouched", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
      });
      const result = submitClaims(DOC_ID, {
        claims: [
          { patch: makePatch("alpha\nBETA\n", "ALPHA\nBETA\n"), description: "ok" },
          // Built against text the sequence never produces: zero fuzz refuses it.
          { patch: makePatch("something\nelse\n", "other\n"), description: "broken" },
        ],
        clientRequestId: "batch-broken",
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PATCH_NOT_APPLICABLE");
      assert.match(result.message, /^Claim 2's patch/);
      // Nothing committed: no packet, no generation, document text untouched.
      const review = driver.getReview(DOC_ID)!;
      assert.equal(review.packets.length, 1);
      assert.equal(review.generation, 1);
      assert.equal(documents.get(DOC_ID), "alpha\nBETA\n");
    });

    it("names the claim whose patch is a no-op and commits nothing", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline);
      // Claim 1 leaves beta alone, so this hunk applies cleanly at zero fuzz
      // to claim 1's output — only the no-op invariant can refuse it.
      const noOp = [
        "--- document",
        "+++ document",
        "@@ -2,1 +2,1 @@",
        "-beta",
        "+beta",
        "",
      ].join("\n");
      const result = submitClaims(DOC_ID, {
        claims: [
          { patch: makePatch(baseline, "ALPHA\nbeta\n"), description: "real" },
          { patch: noOp, description: "does nothing" },
        ],
        clientRequestId: "batch-noop",
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PATCH_INVALID");
      assert.match(result.message, /^Claim 2's patch does not change/);
      assert.equal(driver.getReview(DOC_ID)!.packets.length, 0);
      assert.equal(driver.getReview(DOC_ID)!.generation, 0);
    });

    it("treats each batch claim as its own packet under the retraction rules", function () {
      const baseline = "alpha\nbeta\n";
      const afterFirst = "ALPHA\nbeta\n";
      const afterSecond = "ALPHA\nBETA\n";
      openReview(DOC_ID, baseline);
      const result = submitClaims(DOC_ID, {
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "first" },
          { patch: makePatch(afterFirst, afterSecond), description: "second" },
        ],
        clientRequestId: "batch-retract",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      setDocumentText(DOC_ID, result.workingText);

      // The first claim's packet is not the newest: refused, exactly as a
      // sequentially submitted packet would be.
      const early = driver.retractPacket(result.packetIds[0]);
      assert.equal(early.ok, false);

      // The newest claim's packet retracts to the first claim's text.
      const second = driver.retractPacket(result.packetIds[1]);
      assert.equal(second.ok, true);
      if (!second.ok) {return;}
      assert.equal(second.workingText, afterFirst);
      setDocumentText(DOC_ID, second.workingText);
    });
  });

  describe("decideChunk (accept)", function () {
    it("moves the reference to agree with the document and leaves the document alone", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const result = decideOnlyChunk("accept");
      // Accept touches the reference only — no working text comes back.
      assert.equal(result.workingText, undefined);
      assert.equal(driver.getReview(DOC_ID)!.referenceText, proposed);
      assert.equal(documents.get(DOC_ID), proposed);
      assert.equal(result.unresolvedChunks, 0);
      assert.equal(result.state, "resolved-awaiting-save");
    });

    it("rejects a stale chunkId with CHUNK_NOT_FOUND", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
      });
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      // The user edits the chunk's region before the decision arrives: the
      // content-addressed id no longer names anything in the partition.
      setDocumentText(DOC_ID, "alpha\nBETA-edited\n");
      const result = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        chunks[0].chunkId,
        "accept",
      );
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "CHUNK_NOT_FOUND");
    });

    it("keeps the other chunks' ids valid across a decision", function () {
      const baseline = "alpha\nb\nc\nd\ne\nomega\n";
      const proposed = "ALPHA\nb\nc\nd\ne\nOMEGA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const before = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(before.length, 2);
      const acceptFirst = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        before[0].chunkId,
        "accept",
      );
      assert.equal(acceptFirst.ok, true);
      // The second chunk's id survives the first chunk's decision — the
      // property the old positional chunk-<generation>-<index> ids lacked.
      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 1);
      assert.equal(after[0].chunkId, before[1].chunkId);
      const acceptSecond = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        before[1].chunkId,
        "accept",
      );
      assert.equal(acceptSecond.ok, true);
      assert.equal(driver.countUnresolved(DOC_ID), 0);
    });
  });

  describe("decideChunk (reject)", function () {
    it("returns the working text restored to the reference for the caller to apply", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const result = decideOnlyChunk("reject");
      assert.equal(result.workingText, baseline);
      assert.equal(documents.get(DOC_ID), baseline);
      assert.equal(result.unresolvedChunks, 0);
    });
  });

  describe("decideChunk with block-aware boundaries", function () {
    it("converges chunk by chunk when a mega-patch spans paragraphs and an environment", function () {
      const baseline = [
        "intro", "", "alpha one", "alpha two", "",
        "$$", "\\begin{aligned}", "x &= 1 \\\\", "y &= 2", "\\end{aligned}", "$$",
        "", "tail", "",
      ].join("\n");
      const proposed = [
        "intro", "", "alpha ONE", "", "beta inserted", "",
        "$$", "\\begin{aligned}", "u &= 7 \\\\", "v &= 8 \\\\", "w &= 9", "\\end{aligned}", "$$",
        "", "tail", "",
      ].join("\n");
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });

      // The environment decides whole: exactly one chunk covers it, edge to
      // edge, however the raw diff carved the rewrite.
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      const envChunks = chunks.filter((chunk) => chunk.referenceText.startsWith("$$"));
      assert.equal(envChunks.length, 1, "the $$ environment must be one decision");
      assert.ok(envChunks[0].referenceText.endsWith("$$"));

      // Reject the environment rewrite; the working text restores the
      // baseline environment while the paragraph chunks stay pending.
      const rejected = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        envChunks[0].chunkId,
        "reject",
      );
      assert.equal(rejected.ok, true, `reject failed: ${JSON.stringify(rejected)}`);
      if (rejected.ok && rejected.workingText !== undefined) {
        setDocumentText(DOC_ID, rejected.workingText);
      }
      assert.ok(driver.countUnresolved(DOC_ID) > 0, "paragraph chunks must remain");

      // Accept the remaining chunks one at a time against the recomputed
      // partition until the review resolves.
      for (let guard = 0; guard < 20 && driver.countUnresolved(DOC_ID) > 0; guard++) {
        const remaining = driver.getOutstandingChunks(DOC_ID)!;
        const accepted = driver.decideChunk(
          DOC_ID,
          driver.getReview(DOC_ID)!.reviewId,
          remaining[0].chunkId,
          "accept",
        );
        assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);
      }
      assert.equal(driver.countUnresolved(DOC_ID), 0);

      // The mixed outcome, exactly: proposed paragraphs, baseline environment.
      const expected = [
        "intro", "", "alpha ONE", "", "beta inserted", "",
        "$$", "\\begin{aligned}", "x &= 1 \\\\", "y &= 2", "\\end{aligned}", "$$",
        "", "tail", "",
      ].join("\n");
      assert.equal(documents.get(DOC_ID), expected);
      assert.equal(driver.getReview(DOC_ID)!.referenceText, expected);
    });
  });

  describe("tweak before accept", function () {
    it("accepts the user's tweaked version of a proposed chunk", function () {
      // The property pinned end to end: tweak-before-accept works by
      // construction, not by feature code. The working text IS the live
      // document, so a user edit inside a chunk needs no API; the partition
      // recomputes under a new content-addressed id; and Accept means "the
      // reference agrees with the working text as it stands" — tweak
      // included.
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA improved\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-tweak",
        description: "Improve beta",
      });
      const before = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(before.length, 1);

      // The user edits inside the chunk before deciding.
      const tweaked = "alpha\nBETA improved (user tweak)\ngamma\n";
      setDocumentText(DOC_ID, tweaked);

      // The chunk recomputed under a new id — the stale one is refused —
      // and it still attributes to the claim it grew from.
      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 1);
      assert.notEqual(after[0].chunkId, before[0].chunkId);
      assert.equal(after[0].workingText, "BETA improved (user tweak)");
      assert.deepEqual(after[0].descriptions, ["Improve beta"]);
      const stale = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        before[0].chunkId,
        "accept",
      );
      assert.equal(stale.ok, false);

      // Accepting the recomputed chunk lands the TWEAKED version: the
      // reference converges on the working text, and the document (which the
      // save will write) still carries the user's wording.
      const accepted = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        after[0].chunkId,
        "accept",
      );
      assert.equal(accepted.ok, true);
      if (!accepted.ok) {return;}
      assert.equal(accepted.workingText, undefined);
      assert.equal(driver.getReview(DOC_ID)!.referenceText, tweaked);
      assert.equal(documents.get(DOC_ID), tweaked);
      assert.equal(accepted.unresolvedChunks, 0);
      assert.equal(accepted.state, "resolved-awaiting-save");
    });
  });

  describe("clearUnresolved", function () {
    it("discards outstanding changes but preserves accepted changes", function () {
      const baseline = "alpha\nbeta\ngamma\nomega\n";
      const proposed = "ALPHA\nbeta\nGAMMA\nOMEGA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      // Accept the first chunk (ALPHA)
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      const accept = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        chunks[0].chunkId,
        "accept",
      );
      assert.equal(accept.ok, true);

      // Now clear remaining unresolved
      const clearResult = driver.clearUnresolved(DOC_ID);
      assert.equal(clearResult.ok, true);
      if (!clearResult.ok) {return;}
      setDocumentText(DOC_ID, clearResult.workingText);
      // The document is now the reference: ALPHA accepted, the rest reverted.
      assert.equal(clearResult.workingText, "ALPHA\nbeta\ngamma\nomega\n");
      assert.equal(clearResult.unresolvedChunks, 0);
      assert.equal(driver.countUnresolved(DOC_ID), 0);
    });
  });

  describe("acceptAllChunks", function () {
    it("accepts the whole partition in one sweep, orphaning held comments", function () {
      const baseline = "alpha\nx\ny\nz\nbeta\n";
      const proposed = "ALPHA\nx\ny\nz\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 2);
      // Hold the second chunk with a note: the sweep must accept it anyway
      // and keep the note as an orphaned review-level comment.
      const held = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        chunks[1].chunkId,
        "hold",
        "still thinking",
      );
      assert.equal(held.ok, true);

      const result = driver.acceptAllChunks(DOC_ID);
      assert.equal(result.ok, true, `accept-all failed: ${JSON.stringify(result)}`);
      if (!result.ok) {return;}
      assert.equal(result.acceptedChunks, 2);
      assert.equal(result.unresolvedChunks, 0);
      assert.equal(result.state, "resolved-awaiting-save");
      // The reference moved; the document did not.
      assert.equal(documents.get(DOC_ID), proposed);
      assert.equal(driver.getReview(DOC_ID)!.referenceText, proposed);
      assert.equal(driver.countUnresolved(DOC_ID), 0);
      assert.equal(driver.countHeld(DOC_ID), 0);
      const orphans = driver
        .getReview(DOC_ID)!
        .comments.filter((comment) => comment.orphanedFromChunkId === chunks[1].chunkId);
      assert.equal(orphans.length, 1, "the held note must survive as an orphan");
      assert.equal(orphans[0].text, "still thinking");
    });

    it("refuses without an active review", function () {
      const result = driver.acceptAllChunks("no-such-doc");
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "REVIEW_NOT_FOUND");
    });
  });

  describe("retractPacket", function () {
    it("succeeds for the newest untouched packet and returns the reverted text", function () {
      const baseline = "alpha\nbeta\n";
      const first = "alpha\nBETA\n";
      const second = "ALPHA\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, first),
        clientRequestId: "req-1",
      });
      const submitResult = submitOne(DOC_ID, {
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(submitResult.ok, true);
      if (!submitResult.ok) {return;}
      setDocumentText(DOC_ID, submitResult.workingText);

      const retractResult = driver.retractPacket(submitResult.packetId);
      assert.equal(retractResult.ok, true);
      if (!retractResult.ok) {return;}
      // The returned text is the state after the first packet.
      assert.equal(retractResult.workingText, first);
      setDocumentText(DOC_ID, retractResult.workingText);
    });

    it("fails safely after the packet has been modified by user decisions", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "ALPHA\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      // Reject the chunk, modifying the document
      decideOnlyChunk("reject");
      // Now try to retract the initial packet
      const packetId = driver.getReview(DOC_ID)!.packets[0].packetId;
      const result = driver.retractPacket(packetId);
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PACKET_NOT_RETRACTABLE");
    });

    it("fails safely after accepting a packet", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "ALPHA\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-accept-before-retract",
      });
      decideOnlyChunk("accept");
      const result = driver.retractPacket(driver.getReview(DOC_ID)!.packets[0].packetId);
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PACKET_NOT_RETRACTABLE");
    });

    it("fails for a non-newest packet", function () {
      const baseline = "alpha\n";
      const first = "beta\n";
      const second = "gamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, first),
        clientRequestId: "req-1",
      });
      const secondResult = submitOne(DOC_ID, {
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(secondResult.ok, true);
      if (!secondResult.ok) {return;}
      setDocumentText(DOC_ID, secondResult.workingText);
      // Try to retract the first packet (not the newest)
      const firstPacketId = driver.getReview(DOC_ID)!.packets[0].packetId;
      const result = driver.retractPacket(firstPacketId);
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PACKET_NOT_RETRACTABLE");
    });
  });

  describe("getReviewDiff", function () {
    it("returns exactly the remaining unresolved proposition", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA\nGAMMA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      // beta→BETA and gamma→GAMMA are adjacent lines — one chunk. Accepting
      // requires distance, so rebuild with separated edits instead.
      driver.closeReview(DOC_ID);
      const spacedBaseline = "alpha\nbeta\nx\ny\nz\ngamma\n";
      const spacedProposed = "alpha\nBETA\nx\ny\nz\nGAMMA\n";
      openReview(DOC_ID, spacedBaseline, {
        patch: makePatch(spacedBaseline, spacedProposed),
        clientRequestId: "req-2",
      });
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 2);
      const accept = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        chunks[0].chunkId,
        "accept",
      );
      assert.equal(accept.ok, true);
      // The remaining diff should only show gamma → GAMMA
      const diff = driver.getReviewDiff(DOC_ID);
      assert.notEqual(diff, undefined);
      assert.ok(diff!.includes("-gamma"));
      assert.ok(diff!.includes("+GAMMA"));
      assert.ok(!diff!.includes("-beta"));
    });
  });

  describe("getOutstandingChunks", function () {
    it("returns one chunk for contiguous changes, with exact half-open ranges", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "ALPHA\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const chunks = driver.getOutstandingChunks(DOC_ID);
      assert.notEqual(chunks, undefined);
      assert.equal(chunks!.length, 1);
      assert.equal(chunks![0].referenceRange.fromLine, 1);
      assert.equal(chunks![0].referenceRange.toLine, 3);
      assert.equal(chunks![0].referenceText, "alpha\nbeta");
      assert.equal(chunks![0].workingText, "ALPHA\nBETA");
    });

    it("returns zero chunks after all are resolved", function () {
      const baseline = "alpha\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "ALPHA\n"),
        clientRequestId: "req-1",
      });
      decideOnlyChunk("accept");
      const chunks = driver.getOutstandingChunks(DOC_ID);
      assert.notEqual(chunks, undefined);
      assert.equal(chunks!.length, 0);
    });
  });

  describe("chunk attribution", function () {
    it("attributes the single-patch degenerate case to its packet, with its description", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
        description: "Capitalize beta",
      });
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 1);
      assert.deepEqual(chunks[0].packetIds, [
        driver.getReview(DOC_ID)!.packets[0].packetId,
      ]);
      assert.deepEqual(chunks[0].descriptions, ["Capitalize beta"]);
    });

    it("carries one description per attributed packet, in application order", function () {
      // Every claim carries prose — the contract requires it — so the
      // descriptions array is exactly as long as packetIds, and a chunk that
      // attributes to nothing carries neither.
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
        description: "Capitalize beta",
      });
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks[0].packetIds.length, 1);
      assert.deepEqual(chunks[0].descriptions, ["Capitalize beta"]);
    });

    it("attributes each chunk of a batch to the claim that produced it", function () {
      const baseline = "alpha\nx\ny\nz\nbeta\n";
      openReview(DOC_ID, baseline);
      const afterFirst = "ALPHA\nx\ny\nz\nbeta\n";
      const afterSecond = "ALPHA\nx\ny\nz\nBETA\n";
      const result = submitClaims(DOC_ID, {
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "Fix the opening" },
          { patch: makePatch(afterFirst, afterSecond), description: "Fix the closing" },
        ],
        clientRequestId: "batch-attr",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      setDocumentText(DOC_ID, result.workingText);

      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 2);
      assert.deepEqual(chunks[0].packetIds, [result.packetIds[0]]);
      assert.deepEqual(chunks[0].descriptions, ["Fix the opening"]);
      assert.deepEqual(chunks[1].packetIds, [result.packetIds[1]]);
      assert.deepEqual(chunks[1].descriptions, ["Fix the closing"]);
    });

    it("multi-attributes a chunk two overlapping claims produced", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      openReview(DOC_ID, baseline);
      const afterFirst = "alpha\nBETA\ngamma\n";
      const afterSecond = "alpha\nBETA!\ngamma\n";
      const result = submitClaims(DOC_ID, {
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "Capitalize" },
          { patch: makePatch(afterFirst, afterSecond), description: "Emphasize" },
        ],
        clientRequestId: "batch-overlap",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      setDocumentText(DOC_ID, result.workingText);

      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 1);
      assert.deepEqual(chunks[0].packetIds, result.packetIds);
      assert.deepEqual(chunks[0].descriptions, ["Capitalize", "Emphasize"]);
    });

    it("keeps attribution valid across an accept that shifts later lines", function () {
      // The first chunk inserts a line, so accepting it moves every later
      // reference line down by one — the remaining chunk only stays
      // attributed if the spans were remapped across the splice.
      const baseline = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
      const proposed = "one\nTWO-a\nTWO-b\nthree\nfour\nfive\nSIX\nseven\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-shift",
        description: "Expand two, capitalize six",
      });
      const before = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(before.length, 2);

      const accept = driver.decideChunk(
        DOC_ID,
        driver.getReview(DOC_ID)!.reviewId,
        before[0].chunkId,
        "accept",
      );
      assert.equal(accept.ok, true);

      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 1);
      // The chunk moved from reference line 6 to 7 — attribution followed.
      assert.equal(after[0].referenceRange.fromLine, 7);
      assert.deepEqual(after[0].packetIds, [
        driver.getReview(DOC_ID)!.packets[0].packetId,
      ]);
      assert.deepEqual(after[0].descriptions, ["Expand two, capitalize six"]);
    });

    it("does not attribute a region the user re-edits after a reject", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\ngamma\n"),
        clientRequestId: "req-reject",
        description: "Capitalize beta",
      });
      decideOnlyChunk("reject");
      assert.equal(driver.countUnresolved(DOC_ID), 0);

      // The user edits the same line afterwards: that chunk is the user's,
      // not the rejected packet's.
      setDocumentText(DOC_ID, "alpha\nbeta-user\ngamma\n");
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 1);
      assert.deepEqual(chunks[0].packetIds, []);
      assert.deepEqual(chunks[0].descriptions, []);
    });

    it("does not attribute a chunk the user creates elsewhere during review", function () {
      const baseline = "alpha\nx\ny\nz\nomega\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "ALPHA\nx\ny\nz\nomega\n"),
        clientRequestId: "req-elsewhere",
        description: "Fix alpha",
      });
      // The user edits a line the packet never touched.
      setDocumentText(DOC_ID, "ALPHA\nx\ny\nz\nOMEGA-user\n");
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 2);
      assert.deepEqual(chunks[0].descriptions, ["Fix alpha"]);
      assert.deepEqual(chunks[1].packetIds, []);
      assert.deepEqual(chunks[1].descriptions, []);
    });
  });

  describe("getReviewStatus", function () {
    it("reports active when unresolved chunks remain", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
      });
      const status = driver.getReviewStatus(DOC_ID);
      assert.notEqual(status, undefined);
      assert.equal(status!.state, "active");
      assert.equal(status!.unresolvedChunks, 1);
      assert.equal(status!.packetCount, 1);
    });

    it("reports resolved-awaiting-save when all chunks are resolved", function () {
      const baseline = "alpha\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "ALPHA\n"),
        clientRequestId: "req-1",
      });
      decideOnlyChunk("accept");
      const status = driver.getReviewStatus(DOC_ID);
      assert.notEqual(status, undefined);
      assert.equal(status!.state, "resolved-awaiting-save");
      assert.equal(status!.unresolvedChunks, 0);
    });

    it("reports invalidated identically from status and list", function () {
      const baseline = "alpha\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "beta\n"),
        clientRequestId: "req-1",
      });
      driver.invalidateReview(DOC_ID);
      assert.equal(driver.getReviewStatus(DOC_ID)!.state, "invalidated");
      const listed = driver.listReviews();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].state, "invalidated");
    });
  });

  describe("holds and review comments", function () {
    // Two separated edits → two chunks: ALPHA and BETA.
    const baseline = "alpha\nx\ny\nz\nbeta\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\n";

    function openTwoChunkReview(): string {
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-hold",
      });
      return driver.getReview(DOC_ID)!.reviewId;
    }

    it("holds a chunk out of the save-gate count without touching any text", function () {
      const reviewId = openTwoChunkReview();
      const held: AgentEvent[] = [];
      driver.on("review.held", (event: AgentEvent) => held.push(event));
      assert.equal(driver.countUnresolved(DOC_ID), 2);

      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      const result = driver.decideChunk(
        DOC_ID,
        reviewId,
        chunks[0].chunkId,
        "hold",
        "needs a second look",
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) {
        return;
      }
      assert.equal(result.decision, "hold");
      assert.equal(result.workingText, undefined, "holding must not move any text");
      assert.equal(result.unresolvedChunks, 1);
      assert.equal(result.generation, 2, "a hold is a turn: it advances the generation");
      assert.equal(documents.get(DOC_ID), proposed);
      assert.equal(driver.getReview(DOC_ID)!.referenceText, baseline);

      // The chunk stays in the partition, marked held with its comment.
      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 2, "a held chunk remains a rendered disagreement");
      assert.equal(after[0].state, "held");
      assert.equal(after[0].holdComment, "needs a second look");
      assert.equal(after[1].state, "pending");
      assert.equal(driver.countUnresolved(DOC_ID), 1);
      assert.equal(driver.countHeld(DOC_ID), 1);

      assert.equal(held.length, 1);
      assert.equal(held[0].chunkId, chunks[0].chunkId);
      assert.equal(held[0].comment, "needs a second look");
      assert.equal(held[0].reviewGeneration, 2);
      assert.equal(held[0].unresolvedChunks, 1);
    });

    it("holds without text, and re-holding replaces the comment", function () {
      const reviewId = openTwoChunkReview();
      const chunkId = driver.getOutstandingChunks(DOC_ID)![0].chunkId;
      const bare = driver.decideChunk(DOC_ID, reviewId, chunkId, "hold");
      assert.equal(bare.ok, true);
      assert.equal(driver.getOutstandingChunks(DOC_ID)![0].holdComment, undefined);

      const reheld = driver.decideChunk(DOC_ID, reviewId, chunkId, "hold", "on reflection");
      assert.equal(reheld.ok, true);
      assert.equal(driver.countHeld(DOC_ID), 1, "re-holding must not duplicate the hold");
      assert.equal(driver.getOutstandingChunks(DOC_ID)![0].holdComment, "on reflection");
    });

    it("refuses to hold a stale chunk id", function () {
      const reviewId = openTwoChunkReview();
      const result = driver.decideChunk(DOC_ID, reviewId, "chunk-bogus", "hold");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "CHUNK_NOT_FOUND");
      }
    });

    it("reports resolved-awaiting-save for an accepted+rejected+held mix", function () {
      // Three separated edits → three chunks; one of each decision.
      const wide = "alpha\nx\ny\nz\nbeta\np\nq\nr\ngamma\n";
      const wideProposed = "ALPHA\nx\ny\nz\nBETA\np\nq\nr\nGAMMA\n";
      openReview(DOC_ID, wide, {
        patch: makePatch(wide, wideProposed),
        clientRequestId: "req-mix",
      });
      const reviewId = driver.getReview(DOC_ID)!.reviewId;
      const resolved: AgentEvent[] = [];
      driver.on("review.resolved", (event: AgentEvent) => resolved.push(event));

      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 3);
      const accepted = driver.decideChunk(DOC_ID, reviewId, chunks[0].chunkId, "accept");
      assert.equal(accepted.ok, true);
      const rejected = driver.decideChunk(DOC_ID, reviewId, chunks[1].chunkId, "reject");
      assert.equal(rejected.ok, true);
      if (rejected.ok && rejected.workingText !== undefined) {
        setDocumentText(DOC_ID, rejected.workingText);
      }
      const heldResult = driver.decideChunk(DOC_ID, reviewId, chunks[2].chunkId, "hold", "unsure");
      assert.equal(heldResult.ok, true);
      if (!heldResult.ok) {
        return;
      }

      // The held disagreement remains, but nothing blocks the save gate.
      assert.equal(driver.countUnresolved(DOC_ID), 0);
      assert.equal(heldResult.state, "resolved-awaiting-save");
      const status = driver.getReviewStatus(DOC_ID)!;
      assert.equal(status.state, "resolved-awaiting-save");
      assert.equal(status.heldChunks, 1);
      assert.equal(resolved.length, 1, "pending reaching zero must announce review.resolved");
      assert.equal(driver.getOutstandingChunks(DOC_ID)!.length, 1);
      assert.equal(driver.getOutstandingChunks(DOC_ID)![0].state, "held");
    });

    it("orphans a commented hold as a review-level comment when its chunk is edited", function () {
      const reviewId = openTwoChunkReview();
      const chunkId = driver.getOutstandingChunks(DOC_ID)![0].chunkId;
      const heldOk = driver.decideChunk(DOC_ID, reviewId, chunkId, "hold", "keep the emphasis");
      assert.equal(heldOk.ok, true);
      const commented: AgentEvent[] = [];
      driver.on("review.commented", (event: AgentEvent) => commented.push(event));

      // A user edit inside the held chunk: the content-addressed id changes
      // and the hold dangles. The next observation reconciles it.
      setDocumentText(DOC_ID, documents.get(DOC_ID)!.replace("ALPHA", "ALPHA tweaked"));
      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 2);
      assert.notEqual(after[0].chunkId, chunkId, "the edit must retire the held id");
      assert.equal(after[0].state, "pending", "the reshaped chunk is no longer held");
      assert.equal(driver.countHeld(DOC_ID), 0);
      assert.equal(driver.countUnresolved(DOC_ID), 2);

      // The comment is not silently lost: it surfaces at review level naming
      // the vanished chunk.
      const review = driver.getReview(DOC_ID)!;
      assert.equal(review.comments.length, 1);
      assert.equal(review.comments[0].text, "keep the emphasis");
      assert.equal(review.comments[0].orphanedFromChunkId, chunkId);
      assert.equal(commented.length, 1);
      assert.equal(commented[0].comment, "keep the emphasis");
      assert.equal(commented[0].orphanedFromChunkId, chunkId);
    });

    it("orphans a commented hold when the held chunk is decided", function () {
      const reviewId = openTwoChunkReview();
      const chunkId = driver.getOutstandingChunks(DOC_ID)![0].chunkId;
      driver.decideChunk(DOC_ID, reviewId, chunkId, "hold", "second thoughts");
      const accepted = driver.decideChunk(DOC_ID, reviewId, chunkId, "accept");
      assert.equal(accepted.ok, true);

      assert.equal(driver.countHeld(DOC_ID), 0);
      const review = driver.getReview(DOC_ID)!;
      assert.equal(review.comments.length, 1);
      assert.equal(review.comments[0].orphanedFromChunkId, chunkId);
    });

    it("lets a textless dangling hold vanish without inventing a comment", function () {
      const reviewId = openTwoChunkReview();
      const chunkId = driver.getOutstandingChunks(DOC_ID)![0].chunkId;
      driver.decideChunk(DOC_ID, reviewId, chunkId, "hold");
      const commented: AgentEvent[] = [];
      driver.on("review.commented", (event: AgentEvent) => commented.push(event));

      setDocumentText(DOC_ID, documents.get(DOC_ID)!.replace("ALPHA", "ALPHA tweaked"));
      assert.equal(driver.countHeld(DOC_ID), 0);
      assert.equal(driver.getReview(DOC_ID)!.comments.length, 0);
      assert.equal(commented.length, 0);
    });

    it("keeps a held chunk and its comment through an ordinary line shift", function () {
      const baseline = "alpha\n\nbeta\n\ngamma\n";
      const proposed = "alpha\n\nBETA\n\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-shift-hold",
      });
      const reviewId = driver.getReview(DOC_ID)!.reviewId;
      const before = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(before.length, 1);
      const held = driver.decideChunk(DOC_ID, reviewId, before[0].chunkId, "hold", "keep this note");
      assert.equal(held.ok, true, JSON.stringify(held));

      setDocumentText(DOC_ID, "inserted\n\n" + documents.get(DOC_ID)!);
      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 2);
      const heldAfterShift = after.find((chunk) => chunk.state === "held");
      assert.ok(heldAfterShift !== undefined);
      assert.equal(heldAfterShift.holdComment, "keep this note");
      assert.equal(driver.getReview(DOC_ID)!.comments.length, 0);
    });

    it("does not move a hold onto an identical sibling after its own text is edited", function () {
      const baseline = "same\nb\nsame\n";
      const proposed = "DIFF\nb\nDIFF\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-duplicate-hold",
      });
      const reviewId = driver.getReview(DOC_ID)!.reviewId;
      const first = driver.getOutstandingChunks(DOC_ID)![0];
      const held = driver.decideChunk(DOC_ID, reviewId, first.chunkId, "hold", "first only");
      assert.equal(held.ok, true, JSON.stringify(held));

      setDocumentText(DOC_ID, documents.get(DOC_ID)!.replace("DIFF", "OTHER"));
      const after = driver.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.filter((chunk) => chunk.state === "held").length, 0);
      assert.equal(driver.getReview(DOC_ID)!.comments[0].orphanedFromChunkId, first.chunkId);
      assert.equal(after.some((chunk) => chunk.holdComment === "first only"), false);
    });

    it("appends a review-level comment and advances the generation", function () {
      openTwoChunkReview();
      const commented: AgentEvent[] = [];
      driver.on("review.commented", (event: AgentEvent) => commented.push(event));
      const before = driver.getReview(DOC_ID)!.generation;

      const result = driver.addReviewComment(DOC_ID, "overall: tighten section 2");
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) {
        return;
      }
      assert.equal(result.generation, before + 1, "a comment is a turn the cursor must see");
      assert.equal(result.comment.text, "overall: tighten section 2");
      assert.equal(result.comment.orphanedFromChunkId, undefined);
      assert.equal(driver.getReview(DOC_ID)!.comments.length, 1);
      assert.equal(commented.length, 1);
      assert.equal(commented[0].reviewGeneration, before + 1);
    });

    it("refuses a review-level comment without an active review", function () {
      const result = driver.addReviewComment(DOC_ID, "nobody home");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "REVIEW_NOT_FOUND");
      }
    });
  });

  describe("completeReview", function () {
    it("removes the review from the store", function () {
      openReview(DOC_ID, "alpha\n");
      driver.completeReview(DOC_ID);
      assert.equal(driver.getReview(DOC_ID), undefined);
    });
  });

  describe("validateAndParsePatch", function () {
    it('accepts the generic "document" header', function () {
      const baseline = "alpha\n";
      const proposed = "beta\n";
      const patch = makeGenericHeaderPatch(baseline, proposed);
      const parsed = validateAndParsePatch(patch, DOC_PATH);
      assert.equal(parsed.hunks.length, 1);
    });

    it("accepts the exact canonical document path", function () {
      const baseline = "alpha\n";
      const proposed = "beta\n";
      const patch = makePatch(baseline, proposed);
      const parsed = validateAndParsePatch(patch, DOC_PATH);
      assert.equal(parsed.hunks.length, 1);
    });

    it("accepts git-style a/ and b/ prefixes on the absolute path", function () {
      const baseline = "alpha\n";
      const proposed = "beta\n";
      // `git diff` drops the leading slash when prefixing an absolute path,
      // producing headers such as `--- a/home/user/note.md`.
      const patch = makePatch(baseline, proposed)
        .replace(`--- ${DOC_PATH}`, `--- a${DOC_PATH}`)
        .replace(`+++ ${DOC_PATH}`, `+++ b${DOC_PATH}`);
      const parsed = validateAndParsePatch(patch, DOC_PATH);
      assert.equal(parsed.hunks.length, 1);
    });

    it("rejects a relative header that merely looks like the target", function () {
      const baseline = "alpha\n";
      const proposed = "beta\n";
      // `home/user/note.md` is NOT `/home/user/note.md`. Restoring the leading
      // slash is only correct for a header that carried a git a/ or b/ prefix;
      // doing it unconditionally would let any relative path pass the target
      // check by accident.
      const relative = DOC_PATH.replace(/^\//, "");
      const patch = createPatch(relative, baseline, proposed, "", "", {
        context: 3,
      });
      assert.throws(() => {
        validateAndParsePatch(patch, DOC_PATH);
      }, /do not match/);
    });

    it("rejects basename-only headers", function () {
      const baseline = "alpha\n";
      const proposed = "beta\n";
      const patch = createPatch("note.md", baseline, proposed, "", "", {
        context: 3,
      });
      assert.throws(() => {
        validateAndParsePatch(patch, DOC_PATH);
      }, /do not match/);
    });

    it("rejects binary patches", function () {
      // A minimal binary patch
      const binaryPatch = [
        "--- document",
        "+++ document",
        "GIT binary patch",
        "literal 0",
        "",
        "",
        "literal 0",
        "",
        "",
      ].join("\n");
      assert.throws(() => {
        validateAndParsePatch(binaryPatch, DOC_PATH);
      }, /binary/);
    });

    // The changes issue #34 puts out of scope: they must be refused by name,
    // not applied for their hunks alone. Each patch below carries a valid
    // hunk, so only the metadata check can be what refuses it.
    it("rejects rename, create, and mode-change patches by their metadata", function () {
      const renamePatch = [
        `diff --git a${DOC_PATH} b/renamed.md`,
        "similarity index 95%",
        `rename from ${DOC_PATH}`,
        "rename to renamed.md",
        `--- a${DOC_PATH}`,
        "+++ b/renamed.md",
        "@@ -1,1 +1,1 @@",
        "-alpha",
        "+ALPHA",
        "",
      ].join("\n");
      assert.throws(() => {
        validateAndParsePatch(renamePatch, DOC_PATH);
      }, /rename, copy, create, or delete/);

      const createPatch = [
        `diff --git a${DOC_PATH} b${DOC_PATH}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b${DOC_PATH}`,
        "@@ -0,0 +1,1 @@",
        "+alpha",
        "",
      ].join("\n");
      assert.throws(() => {
        validateAndParsePatch(createPatch, DOC_PATH);
      }, /rename, copy, create, or delete/);

      const modePatch = [
        `diff --git a${DOC_PATH} b${DOC_PATH}`,
        "old mode 100644",
        "new mode 100755",
        `--- a${DOC_PATH}`,
        `+++ b${DOC_PATH}`,
        "@@ -1,1 +1,1 @@",
        "-alpha",
        "+ALPHA",
        "",
      ].join("\n");
      assert.throws(() => {
        validateAndParsePatch(modePatch, DOC_PATH);
      }, /mode-change/);
    });
  });

  describe("listReviews", function () {
    it("lists all active reviews", function () {
      setDocumentText("doc-a", "a\n");
      setDocumentText("doc-b", "b\n");
      driver.openReview({
        documentId: "doc-a",
        documentPath: "/a.md",
        baselineText: "a\n",
        diskBaselineSha256: sha256Text("a\n"),
      });
      driver.openReview({
        documentId: "doc-b",
        documentPath: "/b.md",
        baselineText: "b\n",
        diskBaselineSha256: sha256Text("b\n"),
      });
      const reviews = driver.listReviews();
      assert.equal(reviews.length, 2);
    });
  });

  describe("closeReview", function () {
    it("removes the review and cleans up packet indexes", function () {
      const baseline = "alpha\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "beta\n"),
        clientRequestId: "req-1",
      });
      const packetId = driver.getReview(DOC_ID)!.packets[0].packetId;
      driver.closeReview(DOC_ID);
      assert.equal(driver.getReview(DOC_ID), undefined);
      // Retraction of the closed packet should fail
      const result = driver.retractPacket(packetId);
      assert.equal(result.ok, false);
    });
  });

  /**
   * The properties the whole split rests on. If a transition can reach the
   * committed review, or announce something before its plan is committed,
   * then "a refused mutation leaves no residue" stops being structural and
   * goes back to depending on every caller's cleanup being correct.
   */
  describe("transition purity", function () {
    /** A review with one packet, one hold, and one comment: every container. */
    function populatedReview(): { review: ActiveReviewState; workingText: string } {
      const baseline = "alpha\nx\ny\nz\nbeta\n";
      const proposed = "ALPHA\nx\ny\nz\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-purity",
        description: "caps both ends",
      });
      const reviewId = driver.getReview(DOC_ID)!.reviewId;
      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      driver.decideChunk(DOC_ID, reviewId, chunks[1].chunkId, "hold", "revisit");
      driver.addReviewComment(DOC_ID, "overall note");
      return {
        review: driver.getReview(DOC_ID)!,
        workingText: documents.get(DOC_ID)!,
      };
    }

    it("carries attribution spans on the packet, with no parallel map to restore", function () {
      const { review, workingText } = populatedReview();
      for (const packet of review.packets) {
        assert.ok(packet.refSpans.length > 0, "a committed packet owns its spans");
      }
      // A round trip through the sidecar is the strongest form of the claim:
      // nothing outside the packet has to be re-registered for attribution
      // to survive, because there is nothing outside the packet.
      const restored = reviewFromSidecar(
        "doc-restored",
        reviewSidecar(review, workingText),
      );
      assert.deepEqual(
        restored.packets.map((packet) => packet.refSpans),
        review.packets.map((packet) => packet.refSpans),
      );
      assert.deepEqual(restored.submissions, review.submissions);
    });

    it("never mutates the review it is given", function () {
      const { review, workingText } = populatedReview();
      const before = JSON.parse(JSON.stringify(review)) as ActiveReviewState;
      const chunks = driver.getOutstandingChunks(DOC_ID)!;

      prepareChunkDecision({ review, workingText, chunkId: chunks[0].chunkId, decision: "accept" });
      prepareChunkDecision({ review, workingText, chunkId: chunks[0].chunkId, decision: "reject" });
      prepareChunkDecision({
        review,
        workingText,
        chunkId: chunks[0].chunkId,
        decision: "hold",
        comment: "not committed",
      });
      prepareAcceptAll({ review, workingText });
      prepareClear({ review, workingText });
      prepareReviewComment({ review, workingText, text: "not committed" });
      prepareRetraction({
        review,
        workingText,
        packetId: review.packets[review.packets.length - 1].packetId,
      });
      prepareWorkingTextEdit({
        review,
        workingText: workingText.replace("ALPHA", "ALPHA tweaked"),
      });
      prepareProposalSubmission({
        review,
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        workingText,
        diskSha256: review.diskFenceSha256,
        claims: [
          { patch: makePatch(workingText, workingText.replace("x", "X")), description: "more" },
        ],
        clientRequestId: "req-not-committed",
        requestFingerprint: sha256Text("req-not-committed"),
      });

      assert.deepEqual(review, before, "no prepare* may touch the committed review");
      // Nor may the committed state have moved behind the store's back.
      assert.deepEqual(driver.getReview(DOC_ID), before);
      assert.equal(documents.get(DOC_ID), workingText);
    });

    it("emits nothing during preparation", function () {
      const { review, workingText } = populatedReview();
      const seen: AgentEvent[] = [];
      for (const event of [
        "review.started",
        "review.changed",
        "review.held",
        "review.resolved",
        "review.cleared",
        "review.commented",
        "proposal.applied",
        "proposal.retracted",
      ]) {
        driver.on(event, (announced: AgentEvent) => seen.push(announced));
      }

      const chunks = driver.getOutstandingChunks(DOC_ID)!;
      const decision = prepareChunkDecision({
        review,
        workingText,
        chunkId: chunks[0].chunkId,
        decision: "accept",
      });
      const cleared = prepareClear({ review, workingText });
      assert.ok(!isTransitionError(decision));
      assert.equal(seen.length, 0, "a prepared plan announces nothing");

      // The events are drafted, not fired: they exist in the plan and reach
      // listeners only when a caller commits it.
      assert.ok(
        decision.events.some((draft) => draft.event === "review.changed"),
        "the decision must draft the event its commit owes",
      );
      assert.ok(cleared.events.some((draft) => draft.event === "review.cleared"));
    });

    it("refuses a retraction before any state moves", function () {
      // The interim defect this closes: refusing after mutating left the
      // review advanced by a retraction its caller was told had failed.
      const { review, workingText } = populatedReview();
      const before = JSON.parse(JSON.stringify(review)) as ActiveReviewState;
      const refused = prepareRetraction({
        review,
        workingText,
        // Not the newest packet — a hold and a comment landed after it.
        packetId: review.packets[0].packetId,
      });
      assert.ok(isTransitionError(refused));
      assert.equal(refused.code, "PACKET_NOT_RETRACTABLE");
      assert.deepEqual(driver.getReview(DOC_ID), before);
    });
  });
});
