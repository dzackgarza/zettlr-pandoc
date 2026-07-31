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
  /** The authoritative document text per documentId — the suite is the document owner. */
  let documents: Map<string, string>;

  beforeEach(function () {
    documents = new Map();
    store = new ReviewDiffStore((documentId) => documents.get(documentId));
  });

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
    documents.set(documentId, baseline);
    store.openReview({
      documentId,
      documentPath: DOC_PATH,
      baselineText: baseline,
      diskBaselineSha256: sha256Text(baseline),
    });
    if (initialPatch !== undefined) {
      const submitted = store.submitPacket(documentId, {
        patchFormat: "unified-diff",
        patch: initialPatch.patch,
        clientRequestId: initialPatch.clientRequestId,
        description: initialPatch.description,
      });
      if (!submitted.ok) {
        store.closeReview(documentId);
        throw new Error(submitted.message);
      }
      // The caller's obligation: the returned working text becomes the document.
      documents.set(documentId, submitted.workingText);
    }
  }

  /** Decide the sole outstanding chunk, applying any returned working text. */
  function decideOnlyChunk(decision: "accept" | "reject") {
    const chunks = store.getOutstandingChunks(DOC_ID);
    assert.ok(chunks !== undefined && chunks.length === 1, "expected exactly one chunk");
    const result = store.decideChunk(
      DOC_ID,
      store.getReview(DOC_ID)!.reviewId,
      chunks[0].chunkId,
      decision,
    );
    assert.equal(result.ok, true, `decision failed: ${JSON.stringify(result)}`);
    if (result.ok && result.workingText !== undefined) {
      documents.set(DOC_ID, result.workingText);
    }
    return result;
  }

  describe("openReview", function () {
    it("opens a review whose reference is the baseline", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline);
      const review = store.getReview(DOC_ID)!;
      assert.equal(review.referenceText, baseline);
      assert.equal(review.generation, 0);
      assert.equal(review.packets.length, 0);
      assert.equal(review.diskFenceSha256, sha256Text(baseline));
      assert.equal(store.countUnresolved(DOC_ID), 0);
    });

    it("opens a review with an initial patch as the first packet", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const review = store.getReview(DOC_ID)!;
      assert.equal(documents.get(DOC_ID), proposed);
      assert.equal(review.referenceText, baseline);
      assert.equal(review.generation, 1);
      assert.equal(review.packets.length, 1);
      assert.equal(review.packets[0].clientRequestId, "req-1");
      assert.equal(store.countUnresolved(DOC_ID), 1);
    });

    it("throws if a review is already active for the document", function () {
      openReview(DOC_ID, "alpha\n");
      assert.throws(() => {
        store.openReview({
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

  describe("submitPacket", function () {
    it("applies a second packet to the live document text while preserving unresolved chunks", function () {
      const baseline = "alpha\nbeta\ngamma\n";
      const first = "alpha\nBETA\ngamma\n";
      const second = "ALPHA\nBETA\ngamma\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, first),
        clientRequestId: "req-1",
      });
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      assert.equal(result.workingText, second);
      documents.set(DOC_ID, result.workingText);
      // Both changes are on adjacent lines, so the engine reports one chunk:
      // alpha→ALPHA + beta→BETA
      assert.equal(result.unresolvedChunks, 1);
    });

    it("is idempotent for a repeated clientRequestId", function () {
      const baseline = "alpha\nbeta\n";
      const proposed = "alpha\nBETA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      const first = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(proposed, "alpha\nGAMMA\n"),
        clientRequestId: "req-2",
      });
      assert.equal(first.ok, true);
      if (first.ok) {
        documents.set(DOC_ID, first.workingText);
      }
      const second = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(proposed, "alpha\nGAMMA\n"),
        clientRequestId: "req-2",
      });
      assert.deepEqual(first, second);
    });

    it("does not conflate idempotency keys whose components embed a separator", function () {
      // ("a:b", "c") and ("a", "b:c") collide under a naive
      // `${documentId}:${clientRequestId}` join: a colliding key would replay
      // the first review's cached result for the second review's submission.
      const baseline = "alpha\nbeta\n";
      openReview("a:b", baseline);
      openReview("a", baseline);
      const first = store.submitPacket("a:b", {
        patchFormat: "unified-diff",
        patch: makePatch(baseline, "alpha\nGAMMA\n"),
        clientRequestId: "c",
      });
      assert.equal(first.ok, true);
      if (!first.ok) {return;}
      documents.set("a:b", first.workingText);
      const second = store.submitPacket("a", {
        patchFormat: "unified-diff",
        patch: makePatch(baseline, "ALPHA\nbeta\n"),
        clientRequestId: "b:c",
      });
      assert.equal(second.ok, true, `expected a fresh application: ${JSON.stringify(second)}`);
      if (!second.ok) {return;}
      assert.notEqual(second.packetId, first.packetId);
      assert.notEqual(second.reviewId, first.reviewId);
      assert.equal(second.workingText, "ALPHA\nbeta\n");
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
      // zero fuzz — so nothing upstream of submitPacket catches it.
      const noOp = [
        "--- document",
        "+++ document",
        "@@ -2,1 +2,1 @@",
        "-BETA",
        "+BETA",
        "",
      ].join("\n");
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: noOp,
        clientRequestId: "req-noop",
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "PATCH_INVALID");
      // A rejected no-op must not have advanced the review: a burnt generation
      // makes the no-op the newest packet and blocks retracting the real one.
      const review = store.getReview(DOC_ID);
      assert.ok(review !== undefined);
      assert.equal(review.generation, 1);
      assert.equal(documents.get(DOC_ID), proposed);
    });

    it("rejects with REVISION_MISMATCH when expectedReviewGeneration does not match", function () {
      const baseline = "alpha\n";
      openReview(DOC_ID, baseline);
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(baseline, "beta\n"),
        clientRequestId: "req-1",
        expectedReviewGeneration: 99,
      });
      assert.equal(result.ok, false);
      if (result.ok) {return;}
      assert.equal(result.code, "REVISION_MISMATCH");
    });

    it("rejects with REVIEW_NOT_FOUND when no review is active", function () {
      const result = store.submitPacket("doc-missing", {
        patchFormat: "unified-diff",
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
      const result = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
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
      const result = store.submitClaims(DOC_ID, {
        patchFormat: "unified-diff",
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "Capitalize beta" },
          { patch: makePatch(afterFirst, afterSecond), description: "Capitalize gamma" },
        ],
        clientRequestId: "batch-1",
      });
      assert.equal(result.ok, true, `batch failed: ${JSON.stringify(result)}`);
      if (!result.ok) {return;}
      documents.set(DOC_ID, result.workingText);

      assert.equal(result.workingText, afterSecond);
      assert.equal(result.packetIds.length, 2);
      const review = store.getReview(DOC_ID)!;
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

    it("is all-or-nothing: a failing claim leaves the review untouched", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
      });
      const result = store.submitClaims(DOC_ID, {
        patchFormat: "unified-diff",
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
      const review = store.getReview(DOC_ID)!;
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
      const result = store.submitClaims(DOC_ID, {
        patchFormat: "unified-diff",
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
      assert.equal(store.getReview(DOC_ID)!.packets.length, 0);
      assert.equal(store.getReview(DOC_ID)!.generation, 0);
    });

    it("treats each batch claim as its own packet under the retraction rules", function () {
      const baseline = "alpha\nbeta\n";
      const afterFirst = "ALPHA\nbeta\n";
      const afterSecond = "ALPHA\nBETA\n";
      openReview(DOC_ID, baseline);
      const result = store.submitClaims(DOC_ID, {
        patchFormat: "unified-diff",
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "first" },
          { patch: makePatch(afterFirst, afterSecond), description: "second" },
        ],
        clientRequestId: "batch-retract",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      documents.set(DOC_ID, result.workingText);

      // The first claim's packet is not the newest: refused, exactly as a
      // sequentially submitted packet would be.
      const early = store.retractPacket(result.packetIds[0]);
      assert.equal(early.ok, false);

      // The newest claim's packet retracts to the first claim's text.
      const second = store.retractPacket(result.packetIds[1]);
      assert.equal(second.ok, true);
      if (!second.ok) {return;}
      assert.equal(second.workingText, afterFirst);
      documents.set(DOC_ID, second.workingText);
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
      assert.equal(store.getReview(DOC_ID)!.referenceText, proposed);
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
      const chunks = store.getOutstandingChunks(DOC_ID)!;
      // The user edits the chunk's region before the decision arrives: the
      // content-addressed id no longer names anything in the partition.
      documents.set(DOC_ID, "alpha\nBETA-edited\n");
      const result = store.decideChunk(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
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
      const before = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(before.length, 2);
      const acceptFirst = store.decideChunk(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        before[0].chunkId,
        "accept",
      );
      assert.equal(acceptFirst.ok, true);
      // The second chunk's id survives the first chunk's decision — the
      // property the old positional chunk-<generation>-<index> ids lacked.
      const after = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 1);
      assert.equal(after[0].chunkId, before[1].chunkId);
      const acceptSecond = store.decideChunk(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        before[1].chunkId,
        "accept",
      );
      assert.equal(acceptSecond.ok, true);
      assert.equal(store.countUnresolved(DOC_ID), 0);
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

  describe("clearUnresolved", function () {
    it("discards outstanding changes but preserves accepted changes", function () {
      const baseline = "alpha\nbeta\ngamma\nomega\n";
      const proposed = "ALPHA\nbeta\nGAMMA\nOMEGA\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, proposed),
        clientRequestId: "req-1",
      });
      // Accept the first chunk (ALPHA)
      const chunks = store.getOutstandingChunks(DOC_ID)!;
      const accept = store.decideChunk(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        chunks[0].chunkId,
        "accept",
      );
      assert.equal(accept.ok, true);

      // Now clear remaining unresolved
      const clearResult = store.clearUnresolved(DOC_ID);
      assert.equal(clearResult.ok, true);
      if (!clearResult.ok) {return;}
      documents.set(DOC_ID, clearResult.workingText);
      // The document is now the reference: ALPHA accepted, the rest reverted.
      assert.equal(clearResult.workingText, "ALPHA\nbeta\ngamma\nomega\n");
      assert.equal(clearResult.unresolvedChunks, 0);
      assert.equal(store.countUnresolved(DOC_ID), 0);
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
      const submitResult = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(submitResult.ok, true);
      if (!submitResult.ok) {return;}
      documents.set(DOC_ID, submitResult.workingText);

      const retractResult = store.retractPacket(submitResult.packetId);
      assert.equal(retractResult.ok, true);
      if (!retractResult.ok) {return;}
      // The returned text is the state after the first packet.
      assert.equal(retractResult.workingText, first);
      documents.set(DOC_ID, retractResult.workingText);
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
      const packetId = store.getReview(DOC_ID)!.packets[0].packetId;
      const result = store.retractPacket(packetId);
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
      const result = store.retractPacket(store.getReview(DOC_ID)!.packets[0].packetId);
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
      const secondResult = store.submitPacket(DOC_ID, {
        patchFormat: "unified-diff",
        patch: makePatch(first, second),
        clientRequestId: "req-2",
      });
      assert.equal(secondResult.ok, true);
      if (!secondResult.ok) {return;}
      documents.set(DOC_ID, secondResult.workingText);
      // Try to retract the first packet (not the newest)
      const firstPacketId = store.getReview(DOC_ID)!.packets[0].packetId;
      const result = store.retractPacket(firstPacketId);
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
      store.closeReview(DOC_ID);
      const spacedBaseline = "alpha\nbeta\nx\ny\nz\ngamma\n";
      const spacedProposed = "alpha\nBETA\nx\ny\nz\nGAMMA\n";
      openReview(DOC_ID, spacedBaseline, {
        patch: makePatch(spacedBaseline, spacedProposed),
        clientRequestId: "req-2",
      });
      const chunks = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 2);
      const accept = store.decideChunk(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        chunks[0].chunkId,
        "accept",
      );
      assert.equal(accept.ok, true);
      // The remaining diff should only show gamma → GAMMA
      const diff = store.getReviewDiff(DOC_ID);
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
      const chunks = store.getOutstandingChunks(DOC_ID);
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
      const chunks = store.getOutstandingChunks(DOC_ID);
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
      const chunks = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks.length, 1);
      assert.deepEqual(chunks[0].packetIds, [
        store.getReview(DOC_ID)!.packets[0].packetId,
      ]);
      assert.deepEqual(chunks[0].descriptions, ["Capitalize beta"]);
    });

    it("omits the description of a packet that carries none", function () {
      const baseline = "alpha\nbeta\n";
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "alpha\nBETA\n"),
        clientRequestId: "req-1",
      });
      const chunks = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(chunks[0].packetIds.length, 1);
      assert.deepEqual(chunks[0].descriptions, []);
    });

    it("attributes each chunk of a batch to the claim that produced it", function () {
      const baseline = "alpha\nx\ny\nz\nbeta\n";
      openReview(DOC_ID, baseline);
      const afterFirst = "ALPHA\nx\ny\nz\nbeta\n";
      const afterSecond = "ALPHA\nx\ny\nz\nBETA\n";
      const result = store.submitClaims(DOC_ID, {
        patchFormat: "unified-diff",
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "Fix the opening" },
          { patch: makePatch(afterFirst, afterSecond), description: "Fix the closing" },
        ],
        clientRequestId: "batch-attr",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      documents.set(DOC_ID, result.workingText);

      const chunks = store.getOutstandingChunks(DOC_ID)!;
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
      const result = store.submitClaims(DOC_ID, {
        patchFormat: "unified-diff",
        claims: [
          { patch: makePatch(baseline, afterFirst), description: "Capitalize" },
          { patch: makePatch(afterFirst, afterSecond), description: "Emphasize" },
        ],
        clientRequestId: "batch-overlap",
      });
      assert.equal(result.ok, true);
      if (!result.ok) {return;}
      documents.set(DOC_ID, result.workingText);

      const chunks = store.getOutstandingChunks(DOC_ID)!;
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
      const before = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(before.length, 2);

      const accept = store.decideChunk(
        DOC_ID,
        store.getReview(DOC_ID)!.reviewId,
        before[0].chunkId,
        "accept",
      );
      assert.equal(accept.ok, true);

      const after = store.getOutstandingChunks(DOC_ID)!;
      assert.equal(after.length, 1);
      // The chunk moved from reference line 6 to 7 — attribution followed.
      assert.equal(after[0].referenceRange.fromLine, 7);
      assert.deepEqual(after[0].packetIds, [
        store.getReview(DOC_ID)!.packets[0].packetId,
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
      assert.equal(store.countUnresolved(DOC_ID), 0);

      // The user edits the same line afterwards: that chunk is the user's,
      // not the rejected packet's.
      documents.set(DOC_ID, "alpha\nbeta-user\ngamma\n");
      const chunks = store.getOutstandingChunks(DOC_ID)!;
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
      documents.set(DOC_ID, "ALPHA\nx\ny\nz\nOMEGA-user\n");
      const chunks = store.getOutstandingChunks(DOC_ID)!;
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
      const status = store.getReviewStatus(DOC_ID);
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
      const status = store.getReviewStatus(DOC_ID);
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
      store.invalidateReview(DOC_ID);
      assert.equal(store.getReviewStatus(DOC_ID)!.state, "invalidated");
      const listed = store.listReviews();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].state, "invalidated");
    });
  });

  describe("completeReview", function () {
    it("removes the review from the store", function () {
      openReview(DOC_ID, "alpha\n");
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
  });

  describe("listReviews", function () {
    it("lists all active reviews", function () {
      documents.set("doc-a", "a\n");
      documents.set("doc-b", "b\n");
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
      openReview(DOC_ID, baseline, {
        patch: makePatch(baseline, "beta\n"),
        clientRequestId: "req-1",
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
