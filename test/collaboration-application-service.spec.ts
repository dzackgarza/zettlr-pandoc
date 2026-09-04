/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CollaborationApplicationService boundary tests
 * CVM-Role:        Test
 * Maintainer:     D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The review half of the collaboration service, exercised
 *                  against the real document authority and a real sidecar
 *                  directory. The service owns the review store, sidecar
 *                  persistence, ordering, and events; the annotation half and
 *                  the transaction boundary they share are proved in
 *                  annotation-transitions.spec.ts.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPatch } from "diff";
import { sha256Text } from "@common/util/sha256";
import { CollaborationApplicationService } from "source/app/service-providers/documents/document-collaboration-application-service";
import { collaborationSidecarFilePath } from "source/app/service-providers/documents/collaboration-sidecar-store";
import { harness as sharedHarness, type Harness } from "./collaboration-test-authority";

const DOCUMENT_ID = "doc-service";
const DOCUMENT_PATH = "/tmp/review-service-note.md";

function harness(options: { diskText: string; sidecarDirectory?: string }): Harness {
  return sharedHarness({
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    tmpPrefix: "zettlr-review-service-",
    ...options,
  });
}

function makePatch(oldText: string, newText: string): string {
  return createPatch(DOCUMENT_PATH, oldText, newText, "", "", { context: 3 });
}

describe("CollaborationApplicationService", function () {
  it("commits review state, document text, sidecars, and typed events together", async function () {
    const baseline = "alpha\nbeta\n";
    const proposed = "ALPHA\nBETA\n";
    const { authority, service, emitted } = harness({ diskText: baseline });

    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "capitalize" }],
      clientRequestId: "request-1",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }
    assert.equal(authority.readWorkingText(DOCUMENT_ID), proposed);
    assert.equal(service.reviewStore.getReview(DOCUMENT_ID)?.generation, 1);
    assert.deepEqual(
      emitted.map((entry) => entry.event),
      ["review.started", "proposal.applied"],
    );

    const sidecar = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(sidecar?.workingText, proposed);
    assert.equal(sidecar?.review?.packets.length, 1);

    const decided = await service.acceptAllChunks(
      submitted.reviewId,
      {
        expectedReviewGeneration: submitted.reviewGeneration,
        expectedWorkingSha256: sha256Text(proposed),
      },
    );
    assert.equal(decided.ok, true);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), proposed);
    assert.equal(service.reviewStore.getStatus(DOCUMENT_ID, proposed)?.unresolvedChunks, 0);
    assert.equal((await service.readSidecar(DOCUMENT_PATH))?.review?.generation, 2);
    assert.equal(emitted.at(-1)?.event, "review.resolved");
  });

  it("never offers the user's own edits for adjudication (#65)", async function () {
    const baseline = "alpha\n\nmiddle\n\nomega\n";
    const proposed = "ALPHA\n\nmiddle\n\nomega\n";
    const typed = "ALPHA\n\nmiddle\n\nomega typed\n";
    const { authority, service } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "capitalize" }],
      clientRequestId: "request-user-edit",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    // The user types in an untouched paragraph while the review is open.
    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, typed);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, typed, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });

    assert.equal(
      service.getStatus(DOCUMENT_ID)?.unresolvedChunks,
      1,
      "the user's edit must not count as an unresolved review chunk",
    );
    const chunks = service.getOutstandingChunks(DOCUMENT_ID);
    assert.equal(chunks?.length, 1, "only the proposed edit is adjudicable");
    assert.equal(chunks?.[0].workingText, "ALPHA");

    // The user's edit has no adjudicable chunk: a decision against the raw
    // diff region of their typing must refuse rather than revert it.
    const rejected = await service.decideChunk(
      submitted.reviewId,
      "owner-edit-has-no-suggestion-id",
      "reject",
      {
        expectedReviewGeneration: submitted.reviewGeneration,
        expectedWorkingSha256: sha256Text(typed),
      },
    );
    assert.equal(rejected.ok, false, "user text must not be decidable");
    if (rejected.ok) {
      return;
    }
    assert.equal(rejected.code, "CHUNK_NOT_FOUND");
    assert.equal(
      authority.readWorkingText(DOCUMENT_ID),
      typed,
      "the user's typing must survive untouched",
    );
  });

  it("accepts all proposal chunks without accepting the user's own edit (#65)", async function () {
    const baseline = "alpha\n\nmiddle\n\nomega\n";
    const proposed = "ALPHA\n\nmiddle\n\nomega\n";
    const typed = "ALPHA\n\nmiddle\n\nomega typed\n";
    const { authority, service } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "capitalize" }],
      clientRequestId: "request-accept-all-user-edit",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, typed);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, typed, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });

    const accepted = await service.acceptAllChunks(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(typed),
    });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) {
      return;
    }
    assert.equal(authority.readWorkingText(DOCUMENT_ID), typed);
    assert.equal(accepted.acceptedChunks, 1);
    assert.equal(accepted.unresolvedChunks, 0);
    assert.equal(service.getStatus(DOCUMENT_ID)?.unresolvedChunks, 0);
  });

  it("rejects only agent text after the owner edits inside a suggestion (#68)", async function () {
    const baseline = "prefix suffix\n";
    const proposed = "prefix AGENT suffix\n";
    const edited = "prefix AGUSERENT suffix\n";
    const { authority, service } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "insert AGENT" }],
      clientRequestId: "request-owner-edit-inside-suggestion",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, edited);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });

    const [outstanding] = service.getOutstandingChunks(DOCUMENT_ID) ?? [];
    assert.equal(
      outstanding.workingText,
      "AGENT ",
      "the API projection must exclude owner text inserted inside the suggestion",
    );

    const rejected = await service.clearReview(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(edited),
    });
    assert.equal(rejected.ok, true);
    assert.equal(
      authority.readWorkingText(DOCUMENT_ID),
      "prefix USERsuffix\n",
      "mass rejection must remove agent-authored spans and preserve the owner's interior edit",
    );
  });

  it("keeps an adjacent owner insertion outside the suggestion (#68)", async function () {
    const baseline = "prefix suffix\n";
    const proposed = "prefix AGENT suffix\n";
    const edited = "prefix USERAGENT suffix\n";
    const { authority, service } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "insert AGENT" }],
      clientRequestId: "request-owner-edit-adjacent-to-suggestion",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, edited);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });
    assert.equal(service.getOutstandingChunks(DOCUMENT_ID)?.[0].workingText, "AGENT ");

    const rejected = await service.clearReview(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(edited),
    });
    assert.equal(rejected.ok, true);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), "prefix USERsuffix\n");
  });

  it("maps a deletion seam past later owner text and restores only removed text (#68)", async function () {
    const baseline = "prefix removed tail\n";
    const proposed = "prefix tail\n";
    const edited = "prefix OWNER tail\n";
    const { authority, service } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "remove word" }],
      clientRequestId: "request-deletion-seam",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, edited);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });
    const [outstanding] = service.getOutstandingChunks(DOCUMENT_ID) ?? [];
    assert.equal(outstanding.workingText, "");
    assert.equal(outstanding.workingSpans.length, 1);
    assert.equal(outstanding.workingSpans[0].from, outstanding.workingSpans[0].to);

    const rejected = await service.clearReview(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(edited),
    });
    assert.equal(rejected.ok, true);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), "prefix OWNER removed tail\n");
  });

  it("preserves independent suggestion identity across owner edits and restart (#68)", async function () {
    const baseline = "one middle two\n";
    const firstProposal = "ONE middle two\n";
    const proposed = "ONE middle TWO\n";
    const edited = "OownerNE middle TWO\n";
    const { authority, service, sidecarDirectory } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [
        { patch: makePatch(baseline, firstProposal), description: "capitalize one" },
        { patch: makePatch(firstProposal, proposed), description: "capitalize two" },
      ],
      clientRequestId: "request-independent-suggestions",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const submittedChunks = service.getOutstandingChunks(DOCUMENT_ID);
    assert.ok(submittedChunks !== undefined);
    const firstSubmitted = submittedChunks.find((chunk) => chunk.workingText === "ONE");
    assert.ok(firstSubmitted !== undefined);
    const commented = await service.commentChunk(
      submitted.reviewId,
      firstSubmitted.chunkId,
      "keep owner context",
      {
        expectedReviewGeneration: submitted.reviewGeneration,
        expectedWorkingSha256: sha256Text(proposed),
      },
    );
    assert.equal(commented.ok, true);

    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, edited);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });
    const beforeRestart = service.getOutstandingChunks(DOCUMENT_ID);
    assert.ok(beforeRestart !== undefined);
    const first = beforeRestart.find((chunk) => chunk.workingText === "ONE");
    const second = beforeRestart.find((chunk) => chunk.workingText === "TWO");
    assert.ok(first !== undefined);
    assert.ok(second !== undefined);

    await service.detachCollaboration(DOCUMENT_ID);
    const restarted = new CollaborationApplicationService({
      authority,
      sidecarDirectory,
      emit: () => undefined,
      warn: () => undefined,
    });
    await restarted.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, baseline);
    assert.deepEqual(
      restarted.getOutstandingChunks(DOCUMENT_ID)?.map((chunk) => chunk.chunkId),
      [first.chunkId, second.chunkId],
      "restart must preserve both stable suggestion identities",
    );
    assert.equal(
      restarted.getOutstandingChunks(DOCUMENT_ID)?.[0].comment,
      "keep owner context",
      "the suggestion comment must survive owner edits and restart",
    );

    const restartedReview = restarted.getReview(DOCUMENT_ID);
    assert.ok(restartedReview !== undefined);
    const accepted = await restarted.decideChunk(
      submitted.reviewId,
      second.chunkId,
      "accept",
      {
        expectedReviewGeneration: restartedReview.generation,
        expectedWorkingSha256: sha256Text(edited),
      },
    );
    assert.equal(accepted.ok, true);
    if (!accepted.ok) {
      return;
    }
    assert.equal(
      authority.readWorkingText(DOCUMENT_ID),
      edited,
      "accepting one suggestion must not write document text",
    );
    assert.deepEqual(
      restarted.getOutstandingChunks(DOCUMENT_ID)?.map((chunk) => chunk.chunkId),
      [first.chunkId],
      "accepting one suggestion must leave the other unresolved",
    );

    const rejected = await restarted.decideChunk(
      submitted.reviewId,
      first.chunkId,
      "reject",
      {
        expectedReviewGeneration: accepted.reviewGeneration,
        expectedWorkingSha256: sha256Text(edited),
      },
    );
    assert.equal(rejected.ok, true);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), "oneowner middle TWO\n");
  });

  it("refuses a closed review through an explicit service error", async function () {
    const baseline = "alpha\n";
    const { authority, service } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, "ALPHA\n"), description: "capitalize" }],
      clientRequestId: "request-closed",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }
    authority.close();
    const result = await service.addReviewComment(submitted.reviewId, "note", 1);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "DOCUMENT_CLOSED");
  });

  it("fails reattachment when persisted state is version 3 (#68)", async function () {
    const baseline = "alpha\n";
    const sidecarDirectory = mkdtempSync(join(tmpdir(), "zettlr-review-service-"));
    mkdirSync(sidecarDirectory, { recursive: true });
    writeFileSync(
      collaborationSidecarFilePath(sidecarDirectory, DOCUMENT_PATH),
      JSON.stringify({ version: 3 }),
      "utf8",
    );
    const { service } = harness({ diskText: baseline, sidecarDirectory });
    await assert.rejects(
      service.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, baseline),
      /not a valid collaboration sidecar.*version/,
    );
  });

  it("preserves a saved held review when only a later unsaved edit is discarded", async function () {
    // "Don't save" discards the unsaved delta the prompt names. A held review
    // that was already saved — its sidecar fence matches the bytes on disk —
    // is separately persisted state and is not the discard's to destroy.
    const baseline = "alpha\nbeta\n";
    const proposed = "ALPHA\nbeta\n";
    const { authority, service, sidecarDirectory } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "capitalize" }],
      clientRequestId: "request-discard-preserve",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    // Save the outstanding review: disk now holds the working text and the
    // sidecar fence records it.
    const save = await service.prepareSave(DOCUMENT_ID, sha256Text(proposed));
    assert.ok(save !== undefined);
    await service.completeSave(save!, sha256Text(proposed));
    authority.setDiskText(proposed);

    // A later edit the user chooses not to save.
    const edited = "ALPHA\nbeta later\n";
    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, edited);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });

    await service.discardCollaboration(DOCUMENT_ID, DOCUMENT_PATH, proposed);
    assert.equal(
      service.getReview(DOCUMENT_ID)?.reviewId,
      submitted.reviewId,
      "discarding the unsaved edit must not destroy the saved held review",
    );
    assert.equal(
      (await service.readSidecar(DOCUMENT_PATH))?.review?.reviewId,
      submitted.reviewId,
      "the saved review's sidecar must survive the discard",
    );
  });

  it("owns editor reconciliation, save fencing, and detached reattachment", async function () {
    const baseline = "alpha\nbeta\n";
    const proposed = "ALPHA\nbeta\n";
    const edited = "ALPHA\nBETA edited\n";
    const { authority, service, sidecarDirectory } = harness({ diskText: baseline });
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(baseline),
      claims: [{ patch: makePatch(baseline, proposed), description: "capitalize" }],
      clientRequestId: "request-lifecycle",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const prepared = authority.prepareWorkingTextReplacement(DOCUMENT_ID, edited);
    assert.ok(prepared.change !== undefined);
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, prepared.change.changes, () => {
      authority.commitWorkingTextReplacement(prepared);
    });
    assert.equal(authority.readWorkingText(DOCUMENT_ID), edited);
    assert.equal((await service.readSidecar(DOCUMENT_PATH))?.workingText, edited);

    const save = await service.prepareSave(DOCUMENT_ID, sha256Text(proposed));
    assert.ok(save !== undefined);
    assert.equal((await service.readSidecar(DOCUMENT_PATH))?.pendingSave?.afterDiskSha256, sha256Text(proposed));
    await service.completeSave(save!, sha256Text(proposed));
    assert.equal((await service.readSidecar(DOCUMENT_PATH))?.pendingSave, undefined);

    await service.detachCollaboration(DOCUMENT_ID);
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    authority.close();
    authority.reopen();
    const restored = await service.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, proposed);
    assert.equal(restored?.workingText, edited);
    assert.equal(service.getReview(DOCUMENT_ID)?.reviewId, submitted.reviewId);

    await service.discardCollaboration(DOCUMENT_ID, DOCUMENT_PATH, baseline);
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    assert.equal(await service.readSidecar(DOCUMENT_PATH), undefined);

    authority.setDiskText(edited);
    const secondSubmission = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(edited),
      claims: [{ patch: makePatch(edited, "ALPHA\nBETA again\n"), description: "edit again" }],
      clientRequestId: "request-lifecycle-second",
      expectedReviewGeneration: 0,
    });
    assert.equal(secondSubmission.ok, true);
    await service.detachCollaboration(DOCUMENT_ID);
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    await service.discardCollaboration(DOCUMENT_ID, DOCUMENT_PATH, baseline);
    assert.equal(await service.readSidecar(DOCUMENT_PATH), undefined);
  });
});
