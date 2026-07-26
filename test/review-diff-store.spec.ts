/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiffStore behavioral tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the provider-owned ReviewDiffStore against the
 *                  agent API spec section 15 behavioral requirements that
 *                  the store alone can prove: packet composition, chunk
 *                  decisions, clearing, retraction, idempotency, and
 *                  composite diff computation.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { createPatch } from "diff";
import {
  ReviewDiffStore,
  sha256Text,
  validateAndParsePatch,
} from "source/app/service-providers/documents/review-diff-store";

const DOC_ID = "doc-test";
const DOC_PATH = "/home/user/note.md";

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

describe("ReviewDiffStore", function () {
  let store: ReviewDiffStore;

  beforeEach(function () {
    store = new ReviewDiffStore();
  });

  describe("openReview", function () {
    it("opens a review with referenceText and workingText equal to the baseline", function () {
      const baseline = "alpha\nbeta\n";
      const diskSha = sha256Text(baseline);
      const review = store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: diskSha,
      });
      assert.equal(review.referenceText, baseline);
      assert.equal(review.workingText, baseline);
      assert.equal(review.generation, 0);
      assert.equal(review.packets.length, 0);
      assert.equal(review.diskFenceSha256, diskSha);
    });

    it("opens a review with an initial patch as the first packet", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      const patch = makePatch(baseline, proposed);
      const review = store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch,
          clientRequestId: "req-1",
        },
      });
      assert.equal(review.workingText, proposed);
      assert.equal(review.referenceText, baseline);
      assert.equal(review.generation, 1);
      assert.equal(review.packets.length, 1);
      assert.equal(review.packets[0].clientRequestId, "req-1");
    });

    it("throws if a review is already active for the document", function () {
      const baseline = "alpha\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
      });
      assert.throws(() => {
        store.openReview({
          documentId: DOC_ID,
          documentPath: DOC_PATH,
          baselineText: baseline,
          diskBaselineSha256: sha256Text(baseline),
        });
      }, /already active/);
    });

    it("throws if the initial patch does not change the document", function () {
      const baseline = "alpha\n";
      const patch = makePatch(baseline, baseline);
      assert.throws(() => {
        store.openReview({
          documentId: DOC_ID,
          documentPath: DOC_PATH,
          baselineText: baseline,
          diskBaselineSha256: sha256Text(baseline),
          initialPatch: {
            patchFormat: "unified-diff",
            patch,
            clientRequestId: "req-1",
          },
        });
      }, /does not change/);
    });
  });

  describe("submitPacket", function () {
    it("applies a second packet to the existing working text while preserving unresolved chunks", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const first = "alpha\nBETA\ngamma\n";
      const second = "ALPHA\nBETA\ngamma\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, first),
          clientRequestId: "req-1",
        },
      });
      // Second packet against the current working text
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.workingText, second);
      // Both changes are on adjacent lines, so diffLines coalesces them
      // into a single chunk: alpha→ALPHA + beta→BETA
      assert.equal(result.unresolvedChunks, 1);
    });

    it("is idempotent for a repeated clientRequestId", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const first = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(proposed, "alpha\nGAMMA\n"),
        clientRequestId: "req-2",
      });
      const second = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(proposed, "alpha\nGAMMA\n"),
        clientRequestId: "req-2",
      });
      assert.deepEqual(first, second);
    });

    it("rejects with REVISION_MISMATCH when expectedReviewGeneration does not match", function () {
      const baseline = "alpha\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
      });
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(baseline, "beta\n"),
        clientRequestId: "req-1",
        expectedReviewGeneration: 99,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "REVISION_MISMATCH");
    });

    it("rejects with REVIEW_NOT_FOUND when no review is active", function () {
      const result = store.submitPacket("doc-missing", {
        patchFormat: "unified-diff",
        patch: makePatch("a\n", "b\n"),
        clientRequestId: "req-1",
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "REVIEW_NOT_FOUND");
    });

    it("rejects with PATCH_NOT_APPLICABLE when the patch does not apply with zero fuzz", function () {
      const baseline = "alpha\nbeta\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
      });
      // A patch built against a completely different text
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch("completely\ndifferent\ntext\n", "something\nelse\n"),
        clientRequestId: "req-1",
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "PATCH_NOT_APPLICABLE");
    });
  });

  describe("applyChunkAccept", function () {
    it("updates referenceText to agree with workingText on the accepted range", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA\ngamma\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      // 'beta' is at offset 6, length 4 (including newline)
      const result = store.applyChunkAccept(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        6,
        11,
        1,
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // referenceText should now agree with workingText on the accepted range
      assert.equal(result.referenceText, proposed);
      assert.equal(result.unresolvedChunks, 0);
    });

    it("rejects with REVISION_MISMATCH when the generation is stale", function () {
      const baseline = "alpha\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      const result = store.applyChunkAccept(DOC_ID, reviewId, 0, 0, 99);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "REVISION_MISMATCH");
    });
  });

  describe("applyChunkReject", function () {
    it("updates workingText to agree with referenceText on the rejected range", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA\ngamma\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      // 'BETA' is at offset 6, length 5 (including newline)
      const result = store.applyChunkReject(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        6,
        11,
        1,
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // workingText should now agree with referenceText on the rejected range
      assert.equal(result.workingText, baseline);
      assert.equal(result.unresolvedChunks, 0);
    });
  });

  describe("clearUnresolved", function () {
    it("discards outstanding changes but preserves accepted changes", function () {
      const baseline = "alpha\nbeta\ngamma\nomega\n";
      const proposed = "ALPHA\nbeta\nGAMMA\nOMEGA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      // Accept the first chunk: ALPHA is accepted
      // 'ALPHA' is at offset 0, length 6 (including newline)
      const acceptResult = store.applyChunkAccept(DOC_ID, reviewId, 0, 6, 1);
      assert.equal(acceptResult.ok, true);

      // Now clear remaining unresolved
      const clearResult = store.clearUnresolved(DOC_ID);
      assert.equal(clearResult.ok, true);
      if (!clearResult.ok) return;
      // workingText should now equal referenceText (which has ALPHA accepted)
      assert.equal(clearResult.workingText, "ALPHA\nbeta\ngamma\nomega\n");
      assert.equal(clearResult.unresolvedChunks, 0);
    });

    it("does NOT restore the document to the initial baseline (preserves accepted changes)", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "ALPHA\nBETA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      // Accept ALPHA
      store.applyChunkAccept(DOC_ID, reviewId, 0, 6, 1);
      // Clear remaining (BETA is still unresolved)
      const result = store.clearUnresolved(DOC_ID);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // workingText has ALPHA accepted, BETA reverted to baseline
      assert.notEqual(result.workingText, baseline);
      assert.equal(result.workingText, "ALPHA\nbeta\n");
    });
  });

  describe("retractPacket", function () {
    it("succeeds for the newest untouched packet and reverts its changes", function () {
      const baseline = "alpha\nbeta\n";
      const first = "alpha\nBETA\n";
      const second = "ALPHA\nBETA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, first),
          clientRequestId: "req-1",
        },
      });
      const submitResult = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(submitResult.ok, true);
      if (!submitResult.ok) return;

      const retractResult = store.retractPacket(submitResult.packetId);
      assert.equal(retractResult.ok, true);
      if (!retractResult.ok) return;
      // workingText should be back to the state after the first packet
      const reviewState = store.getReview(DOC_ID);
      assert.equal(reviewState?.workingText, first);
    });

    it("fails safely after the packet has been modified by user decisions", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "ALPHA\nbeta\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      // Reject the chunk, modifying workingText
      store.applyChunkReject(DOC_ID, reviewId, 0, 6, 1);
      // Now try to retract the initial packet
      const packetId = store.getReview(DOC_ID)!.packets[0].packetId;
      const result = store.retractPacket(packetId);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "PACKET_NOT_RETRACTABLE");
    });

    it("fails for a non-newest packet", function () {
      const baseline = "alpha\n";
      const first = "beta\n";
      const second = "gamma\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, first),
          clientRequestId: "req-1",
        },
      });
      const secondResult = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(secondResult.ok, true);
      if (!secondResult.ok) return;
      // Try to retract the first packet (not the newest)
      const firstPacketId = store.getReview(DOC_ID)!.packets[0].packetId;
      const result = store.retractPacket(firstPacketId);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "PACKET_NOT_RETRACTABLE");
    });
  });

  describe("getReviewDiff", function () {
    it("returns exactly the remaining unresolved proposition", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const proposed = "alpha\nBETA\nGAMMA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      // Accept the beta change
      store.applyChunkAccept(DOC_ID, reviewId, 6, 11, 1);
      // The remaining diff should only show gamma → GAMMA
      const diff = store.getReviewDiff(DOC_ID);
      assert.notEqual(diff, undefined);
      assert.ok(diff!.includes("-gamma"));
      assert.ok(diff!.includes("+GAMMA"));
      assert.ok(!diff!.includes("-beta"));
    });
  });

  describe("getOutstandingChunks", function () {
    it("returns chunks for the current generation", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "ALPHA\nBETA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const chunks = store.getOutstandingChunks(DOC_ID);
      assert.notEqual(chunks, undefined);
      assert.equal(chunks!.length, 2); // two changed lines
    });

    it("returns zero chunks after all are resolved", function () {
      const baseline = "alpha\n";
      const proposed = "ALPHA\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, proposed),
          clientRequestId: "req-1",
        },
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      store.applyChunkAccept(DOC_ID, reviewId, 0, 6, 1);
      const chunks = store.getOutstandingChunks(DOC_ID);
      assert.notEqual(chunks, undefined);
      assert.equal(chunks!.length, 0);
    });
  });

  describe("getReviewStatus", function () {
    it("reports active when unresolved chunks remain", function () {
      const baseline = "alpha\nbeta\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, "alpha\nBETA\n"),
          clientRequestId: "req-1",
        },
      });
      const status = store.getReviewStatus(DOC_ID);
      assert.notEqual(status, undefined);
      assert.equal(status!.state, "active");
      assert.equal(status!.unresolvedChunks, 1);
      assert.equal(status!.packetCount, 1);
    });

    it("reports resolved-awaiting-save when all chunks are resolved", function () {
      const baseline = "alpha\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, "ALPHA\n"),
          clientRequestId: "req-1",
        },
      });
      const reviewId = store.getReview(DOC_ID)!.reviewId;
      store.applyChunkAccept(DOC_ID, reviewId, 0, 6, 1);
      const status = store.getReviewStatus(DOC_ID);
      assert.notEqual(status, undefined);
      assert.equal(status!.state, "resolved-awaiting-save");
      assert.equal(status!.unresolvedChunks, 0);
    });
  });

  describe("completeReview", function () {
    it("removes the review from the store", function () {
      const baseline = "alpha\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
      });
      store.completeReview(DOC_ID);
      assert.equal(store.getReview(DOC_ID), undefined);
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
  });

  describe("listReviews", function () {
    it("lists all active reviews", function () {
      store.openReview({
        documentId: "doc-a",
        documentPath: "/a.md",
        baselineText: "a\n",
        diskBaselineSha256: sha256Text("a\n"),
      });
      store.openReview({
        documentId: "doc-b",
        documentPath: "/b.md",
        baselineText: "b\n",
        diskBaselineSha256: sha256Text("b\n"),
      });
      const reviews = store.listReviews();
      assert.equal(reviews.length, 2);
    });
  });

  describe("closeReview", function () {
    it("removes the review and cleans up packet indexes", function () {
      const baseline = "alpha\n";
      store.openReview({
        documentId: DOC_ID,
        documentPath: DOC_PATH,
        baselineText: baseline,
        diskBaselineSha256: sha256Text(baseline),
        initialPatch: {
          patchFormat: "unified-diff",
          patch: makePatch(baseline, "beta\n"),
          clientRequestId: "req-1",
        },
      });
      const packetId = store.getReview(DOC_ID)!.packets[0].packetId;
      store.closeReview(DOC_ID);
      assert.equal(store.getReview(DOC_ID), undefined);
      // Retraction of the closed packet should fail
      const result = store.retractPacket(packetId);
      assert.equal(result.ok, false);
    });
  });
});
