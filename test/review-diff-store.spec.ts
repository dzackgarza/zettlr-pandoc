/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Review transition and projection tests
 * CVM-Role:        Test
 * Maintainer:     D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Tests the pure review transitions and the store's read
 *                  projections. Application ordering belongs to the
 *                  ReviewApplicationService tests.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { ChangeSet } from "@codemirror/state";
import { createPatch } from "diff";
import {
  proposalRequestFingerprint,
  ReviewDiffStore,
  reviewFromSidecar,
  reviewSidecar,
} from "source/app/service-providers/documents/review-diff-store";
import { sha256Text } from "source/common/util/sha256";
import {
  isTransitionError,
  prepareChunkComment,
  prepareChunkDecision,
  prepareClear,
  prepareProposalSubmission,
  prepareRetraction,
  prepareWorkingTextEdit,
  type ReviewTransitionError,
} from "source/app/service-providers/documents/review-transitions";

const DOCUMENT_ID = "doc-test";
const DOCUMENT_PATH = "/home/user/note.md";

function patch(oldText: string, newText: string): string {
  return createPatch(DOCUMENT_PATH, oldText, newText, "", "", { context: 3 });
}

function committedProposal(
  baseline: string,
  proposed: string,
  clientRequestId = "request-1",
) {
  const claims = [{ patch: patch(baseline, proposed), description: "one claim" }];
  const plan = prepareProposalSubmission({
    review: undefined,
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    workingText: baseline,
    diskSha256: sha256Text(baseline),
    claims,
    clientRequestId,
    requestFingerprint: proposalRequestFingerprint({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      expectedReviewGeneration: 0,
      claims,
    }),
  });
  if (isTransitionError(plan)) {
    throw new Error(plan.code);
  }
  return plan;
}

function withReview(baseline: string, proposed: string) {
  const plan = committedProposal(baseline, proposed);
  return { review: plan.nextReview!, workingText: plan.nextWorkingText };
}

function assertTransitionError(
  value: unknown,
  code: string,
): void {
  assert.equal((value as { ok?: boolean }).ok, false);
  assert.equal((value as ReviewTransitionError).code, code);
}

describe("pure review transitions", function () {
  it("applies ordered claims as separate packets", function () {
    const baseline = "alpha\nbeta\ngamma\n";
    const first = "alpha\nBETA\ngamma\n";
    const second = "alpha\nBETA\nGAMMA\n";
    const claims = [
      { patch: patch(baseline, first), description: "capitalize beta" },
      { patch: patch(first, second), description: "capitalize gamma" },
    ];
    const result = prepareProposalSubmission({
      review: undefined,
      documentId: DOCUMENT_ID,
      documentPath: DOCUMENT_PATH,
      workingText: baseline,
      diskSha256: sha256Text(baseline),
      claims,
      clientRequestId: "batch-1",
      requestFingerprint: sha256Text("batch-1"),
    });
    assert.ok(!isTransitionError(result));
    assert.equal(result.nextWorkingText, second);
    assert.equal(result.nextReview?.packets.length, 2);
    assert.deepEqual(result.nextReview?.submissions[0].packetIds, result.response.packetIds);
  });

  it("refuses a patch that does not apply and leaves no candidate state", function () {
    const baseline = "alpha\nbeta\n";
    const result = prepareProposalSubmission({
      review: undefined,
      documentId: DOCUMENT_ID,
      documentPath: DOCUMENT_PATH,
      workingText: baseline,
      diskSha256: sha256Text(baseline),
      claims: [{ patch: patch("unrelated\n", "other\n"), description: "wrong base" }],
      clientRequestId: "refused",
      requestFingerprint: sha256Text("refused"),
    });
    assertTransitionError(result, "PATCH_NOT_APPLICABLE");
  });

  it("decides chunks, carries comments, and clears unresolved state", function () {
    const { review, workingText } = withReview("alpha\nbeta\n", "ALPHA\nBETA\n");
    const chunks = new ReviewDiffStore();
    chunks.replaceReview(DOCUMENT_ID, review);
    const outstanding = chunks.getOutstandingChunks(DOCUMENT_ID, workingText)!;
    assert.ok(outstanding.length > 0);

    const noted = prepareChunkComment({
      review,
      workingText,
      chunkId: outstanding[0].chunkId,
      text: "check this",
    });
    assert.ok(!isTransitionError(noted));
    assert.equal(noted.nextReview?.chunkComments.length, 1);

    const decided = prepareChunkDecision({
      review: noted.nextReview!,
      workingText,
      chunkId: outstanding[0].chunkId,
      decision: "accept",
    });
    assert.ok(!isTransitionError(decided));
    assert.equal(decided.nextReview?.suggestions[0].state, "accepted");

    const cleared = prepareClear({ review, workingText });
    assert.ok(!isTransitionError(cleared));
    assert.equal(cleared.response.state, "cleared");
    assert.equal(cleared.nextReview?.generation, review.generation + 1);
    assert.equal(cleared.nextWorkingText, "alpha\nbeta\n");
  });

  it("retracts only the newest untouched packet", function () {
    const first = committedProposal("alpha\n", "ALPHA\n");
    const second = prepareProposalSubmission({
      review: first.nextReview,
      documentId: DOCUMENT_ID,
      documentPath: DOCUMENT_PATH,
      workingText: first.nextWorkingText,
      diskSha256: first.nextReview!.diskFenceSha256,
      claims: [{
        patch: patch(first.nextWorkingText, "prefix ALPHA\n"),
        description: "prefix",
      }],
      clientRequestId: "request-2",
      requestFingerprint: sha256Text("request-2"),
    });
    assert.ok(!isTransitionError(second));
    const latest = second.nextReview!.packets.at(-1)!.packetId;
    const retracted = prepareRetraction({
      review: second.nextReview!,
      workingText: second.nextWorkingText,
      packetId: latest,
    });
    assert.ok(!isTransitionError(retracted));
    assert.equal(retracted.nextWorkingText, first.nextWorkingText);
    assert.equal(retracted.nextReview?.packets.length, 1);
    const store = new ReviewDiffStore();
    store.replaceReview(DOCUMENT_ID, retracted.nextReview!);
    assert.equal(
      store.getOutstandingChunks(DOCUMENT_ID, retracted.nextWorkingText)?.[0].workingText,
      "ALPHA",
    );
  });

  it("keeps preparation pure and drafts events without emitting them", function () {
    const { review, workingText } = withReview("alpha\n", "ALPHA\n");
    const before = structuredClone(review);
    const chunks = new ReviewDiffStore();
    chunks.replaceReview(DOCUMENT_ID, review);
    const chunk = chunks.getOutstandingChunks(DOCUMENT_ID, workingText)![0];
    const decision = prepareChunkDecision({
      review,
      workingText,
      chunkId: chunk.chunkId,
      decision: "accept",
    });
    assert.ok(!isTransitionError(decision));
    assert.ok(decision.events.some((event) => event.event === "review.changed"));
    assert.deepEqual(review, before);

    const refused = prepareRetraction({
      review,
      workingText,
      packetId: "not-the-latest-packet",
    });
    assertTransitionError(refused, "PACKET_NOT_RETRACTABLE");
    assert.deepEqual(review, before);
  });

  it("reconciles a working-text edit without mutating the input", function () {
    const baseline = "alpha\n";
    const { review, workingText } = withReview(baseline, "ALPHA\n");
    const store = new ReviewDiffStore();
    store.replaceReview(DOCUMENT_ID, review);
    const chunk = store.getOutstandingChunks(DOCUMENT_ID, workingText)![0];
    const noted = prepareChunkComment({
      review,
      workingText,
      chunkId: chunk.chunkId,
      text: "keep this context",
    });
    assert.ok(!isTransitionError(noted));
    const before = structuredClone(noted.nextReview!);
    const edit = prepareWorkingTextEdit({
      review: noted.nextReview!,
      workingText: baseline,
      changes: ChangeSet.of(
        { from: 0, to: workingText.length, insert: baseline },
        workingText.length,
      ),
    });
    assert.ok(edit !== undefined);
    assert.deepEqual(noted.nextReview, before);
  });

  it("maps each deletion restoration when owner text changes between seams", function () {
    const baseline = "one middle two\n";
    const proposed = " middle \n";
    const { review, workingText } = withReview(baseline, proposed);
    assert.ok(review.suggestions.every((suggestion) =>
      suggestion.anchors.every((anchor) => anchor.from === anchor.to),
    ));
    const insertionAt = workingText.indexOf("dle");
    const ownerText = "OWNER";
    const edited =
      workingText.slice(0, insertionAt) + ownerText + workingText.slice(insertionAt);
    const edit = prepareWorkingTextEdit({
      review,
      workingText: edited,
      changes: ChangeSet.of(
        { from: insertionAt, insert: ownerText },
        workingText.length,
      ),
    });
    assert.ok(edit !== undefined);

    const rejected = prepareClear({
      review: edit.nextReview!,
      workingText: edited,
    });
    assert.ok(!isTransitionError(rejected));
    assert.equal(rejected.nextWorkingText, "one midOWNERdle two\n");
  });

  it("maps an earlier suggestion through a later claim and later rejection", function () {
    const baseline = "alpha beta\n";
    const first = "ALPHA beta\n";
    const final = "prefix ALPHA beta\n";
    const claims = [
      { patch: patch(baseline, first), description: "capitalize alpha" },
      { patch: patch(first, final), description: "add prefix" },
    ];
    const submitted = prepareProposalSubmission({
      review: undefined,
      documentId: DOCUMENT_ID,
      documentPath: DOCUMENT_PATH,
      workingText: baseline,
      diskSha256: sha256Text(baseline),
      claims,
      clientRequestId: "mapped-claims",
      requestFingerprint: sha256Text("mapped-claims"),
    });
    assert.ok(!isTransitionError(submitted));
    const store = new ReviewDiffStore();
    store.replaceReview(DOCUMENT_ID, submitted.nextReview!);
    const chunks = store.getOutstandingChunks(DOCUMENT_ID, final)!;
    const capitalized = chunks.find((chunk) =>
      chunk.descriptions.includes("capitalize alpha"),
    );
    const prefixed = chunks.find((chunk) => chunk.descriptions.includes("add prefix"));
    assert.equal(capitalized?.workingText, "ALPHA");
    assert.equal(prefixed?.workingText, "prefix ");

    const prefixRejected = prepareChunkDecision({
      review: submitted.nextReview!,
      workingText: final,
      chunkId: prefixed!.chunkId,
      decision: "reject",
    });
    assert.ok(!isTransitionError(prefixRejected));
    assert.equal(prefixRejected.nextWorkingText, first);

    const capitalRejected = prepareChunkDecision({
      review: prefixRejected.nextReview!,
      workingText: prefixRejected.nextWorkingText,
      chunkId: capitalized!.chunkId,
      decision: "reject",
    });
    assert.ok(!isTransitionError(capitalRejected));
    assert.equal(capitalRejected.nextWorkingText, baseline);
  });

  it("maps sibling identity through rejection of repeated text", function () {
    const { review } = withReview("", "aa");
    const packetId = review.packets[0].packetId;
    review.suggestions = [
      {
        suggestionId: "first-a",
        packetId,
        kind: "insertion",
        removedText: "",
        restorations: [],
        anchors: [{ from: 0, to: 1 }],
        seam: 0,
        state: "proposed",
      },
      {
        suggestionId: "second-a",
        packetId,
        kind: "insertion",
        removedText: "",
        restorations: [],
        anchors: [{ from: 1, to: 2 }],
        seam: 1,
        state: "proposed",
      },
    ];
    const firstRejected = prepareChunkDecision({
      review,
      workingText: "aa",
      chunkId: "first-a",
      decision: "reject",
    });
    assert.ok(!isTransitionError(firstRejected));
    assert.equal(firstRejected.nextWorkingText, "a");
    assert.deepEqual(firstRejected.nextReview?.suggestions[1].anchors, [{ from: 0, to: 1 }]);

    const secondRejected = prepareChunkDecision({
      review: firstRejected.nextReview!,
      workingText: firstRejected.nextWorkingText,
      chunkId: "second-a",
      decision: "reject",
    });
    assert.ok(!isTransitionError(secondRejected));
    assert.equal(secondRejected.nextWorkingText, "");
  });

  it("withdraws a suggestion when an owner edit destroys its complete anchor", function () {
    const baseline = "prefix suffix\n";
    const proposed = "prefix AGENT suffix\n";
    const { review, workingText } = withReview(baseline, proposed);
    const anchor = review.suggestions[0].anchors[0];
    const edited = workingText.slice(0, anchor.from) + workingText.slice(anchor.to);
    const edit = prepareWorkingTextEdit({
      review,
      workingText: edited,
      changes: ChangeSet.of({ from: anchor.from, to: anchor.to }, workingText.length),
    });
    assert.ok(edit !== undefined);
    assert.equal(edit.nextReview?.suggestions[0].state, "withdrawn");
    const store = new ReviewDiffStore();
    store.replaceReview(DOCUMENT_ID, edit.nextReview!);
    assert.deepEqual(store.getOutstandingChunks(DOCUMENT_ID, edited), []);
  });

  it("round-trips packet attribution through the sidecar", function () {
    const { review, workingText } = withReview("alpha\n", "ALPHA\n");
    const restored = reviewFromSidecar("restored", reviewSidecar(review, workingText));
    assert.deepEqual(restored.suggestions, review.suggestions);
    assert.deepEqual(restored.submissions, review.submissions);
  });
});

describe("ReviewDiffStore projections", function () {
  it("derive status, chunks, and a composite diff from live text", function () {
    const { review, workingText } = withReview("alpha\n", "ALPHA\n");
    const store = new ReviewDiffStore();
    store.replaceReview(DOCUMENT_ID, review);
    const status = store.getStatus(DOCUMENT_ID, workingText)!;
    assert.equal(status.unresolvedChunks, 1);
    assert.ok(store.getOutstandingChunks(DOCUMENT_ID, workingText)?.length === 1);
    assert.equal(store.getReviewDiff(DOCUMENT_ID, workingText)?.includes("-alpha"), true);
  });
});
