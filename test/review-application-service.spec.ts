/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewApplicationService boundary tests
 * CVM-Role:        Test
 * Maintainer:     D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Exercises the real application service with a narrow
 *                  document-authority implementation. The service owns the
 *                  review store, sidecar persistence, ordering, and events.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ChangeSet, Text } from "@codemirror/state";
import { createPatch } from "diff";
import type { AgentEventType } from "@dts/common/agent-api";
import type { SerializedUpdate } from "@dts/common/documents";
import { sha256Text } from "@common/util/sha256";
import serializeChangeSet from "@common/util/serialize-change-set";
import { computeReviewChunks } from "@common/modules/review/review-chunks";
import {
  ReviewApplicationService,
  type AgentEventPayload,
  type PreparedDocumentMutation,
  type ReviewDocumentAuthority,
} from "source/app/service-providers/documents/review-application-service";

const DOCUMENT_ID = "doc-service";
const DOCUMENT_PATH = "/tmp/review-service-note.md";

class DocumentAuthority implements ReviewDocumentAuthority {
  public text: Text;
  public readonly events: AgentEventType[] = [];
  private version = 0;
  private open = true;

  constructor(private diskText: string) {
    this.text = Text.of(diskText.split("\n"));
  }

  resolveDocumentPath(documentId: string): string | undefined {
    return documentId === DOCUMENT_ID && this.open ? DOCUMENT_PATH : undefined;
  }

  isDocumentOpen(documentPath: string): boolean {
    return documentPath === DOCUMENT_PATH && this.open;
  }

  close(): void {
    this.open = false;
  }

  reopen(): void {
    this.open = true;
  }

  setDiskText(text: string): void {
    this.diskText = text;
  }

  async acquireDocument(documentId: string) {
    assert.equal(documentId, DOCUMENT_ID);
    return { documentId, documentPath: DOCUMENT_PATH, wasAlreadyLoaded: true };
  }

  readWorkingText(documentId: string): string | undefined {
    return documentId === DOCUMENT_ID ? this.text.toString() : undefined;
  }

  async readDiskText(documentPath: string): Promise<string> {
    assert.equal(documentPath, DOCUMENT_PATH);
    return this.diskText;
  }

  readSavedDiskSha256(documentId: string): string | undefined {
    return documentId === DOCUMENT_ID ? sha256Text(this.diskText) : undefined;
  }

  prepareWorkingTextReplacement(
    documentId: string,
    nextText: string,
  ): PreparedDocumentMutation {
    assert.equal(documentId, DOCUMENT_ID);
    const currentText = this.text.toString();
    if (currentText === nextText) {
      return { documentId, documentPath: DOCUMENT_PATH, change: undefined };
    }
    let prefix = 0;
    while (
      prefix < currentText.length &&
      prefix < nextText.length &&
      currentText[prefix] === nextText[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < currentText.length - prefix &&
      suffix < nextText.length - prefix &&
      currentText[currentText.length - suffix - 1] ===
        nextText[nextText.length - suffix - 1]
    ) {
      suffix += 1;
    }
    const changes = ChangeSet.of(
      [
        {
          from: prefix,
          to: currentText.length - suffix,
          insert: nextText.slice(prefix, nextText.length - suffix),
        },
      ],
      this.text.length,
    );
    const update: SerializedUpdate = {
      changes: serializeChangeSet(changes),
      clientID: "review-service-test",
    };
    return {
      documentId,
      documentPath: DOCUMENT_PATH,
      change: {
        changes,
        update,
        nextText: Text.of(nextText.split("\n")),
        nextVersion: this.version + 1,
      },
    };
  }

  commitWorkingTextReplacement(prepared: PreparedDocumentMutation): void {
    if (prepared.change === undefined) {
      return;
    }
    this.text = prepared.change.nextText;
    this.version = prepared.change.nextVersion;
  }

  async releaseTemporaryDocument(documentId: string): Promise<void> {
    assert.equal(documentId, DOCUMENT_ID);
  }

  broadcastReviewState(documentId: string): void {
    assert.equal(documentId, DOCUMENT_ID);
  }

  broadcastReviewCleared(documentId: string, reviewId: string): void {
    assert.equal(documentId, DOCUMENT_ID);
    assert.ok(reviewId.length > 0);
  }
}

function makePatch(oldText: string, newText: string): string {
  return createPatch(DOCUMENT_PATH, oldText, newText, "", "", { context: 3 });
}

describe("ReviewApplicationService", function () {
  it("commits review state, document text, sidecars, and typed events together", async function () {
    const baseline = "alpha\nbeta\n";
    const proposed = "ALPHA\nBETA\n";
    const authority = new DocumentAuthority(baseline);
    const emitted: Array<{ event: AgentEventType; payload: AgentEventPayload }> = [];
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-review-service-")),
      emit: (event, payload) => {
        emitted.push({ event, payload });
        authority.events.push(event);
      },
      warn: () => undefined,
    });

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
    assert.deepEqual(authority.events, ["review.started", "proposal.applied"]);

    const sidecar = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(sidecar?.workingText, proposed);
    assert.equal(sidecar?.packets.length, 1);

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
    assert.equal((await service.readSidecar(DOCUMENT_PATH))?.generation, 2);
    assert.equal(emitted.at(-1)?.event, "review.resolved");
  });

  it("never offers the user's own edits for adjudication (#65)", async function () {
    const baseline = "alpha\n\nmiddle\n\nomega\n";
    const proposed = "ALPHA\n\nmiddle\n\nomega\n";
    const typed = "ALPHA\n\nmiddle\n\nomega typed\n";
    const authority = new DocumentAuthority(baseline);
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-review-service-")),
      emit: () => undefined,
      warn: () => undefined,
    });
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
    const review = service.getReview(DOCUMENT_ID)!;
    const userChunk = computeReviewChunks(review.referenceText, typed).find(
      (chunk) => chunk.workingText.includes("omega typed"),
    )!;
    const rejected = await service.decideChunk(
      submitted.reviewId,
      userChunk.chunkId,
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
    const authority = new DocumentAuthority(baseline);
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-review-service-")),
      emit: () => undefined,
      warn: () => undefined,
    });
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
    const authority = new DocumentAuthority(baseline);
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-review-service-")),
      emit: () => undefined,
      warn: () => undefined,
    });
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
      "AGENT",
      "the API projection must exclude owner text inserted inside the suggestion",
    );

    const rejected = await service.clearReview(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(edited),
    });
    assert.equal(rejected.ok, true);
    assert.equal(
      authority.readWorkingText(DOCUMENT_ID),
      "prefix USER suffix\n",
      "mass rejection must remove agent-authored spans and preserve the owner's interior edit",
    );
  });

  it("preserves independent suggestion identity across owner edits and restart (#68)", async function () {
    const baseline = "one middle two\n";
    const firstProposal = "ONE middle two\n";
    const proposed = "ONE middle TWO\n";
    const edited = "OownerNE middle TWO\n";
    const authority = new DocumentAuthority(baseline);
    const sidecarDirectory = mkdtempSync(join(tmpdir(), "zettlr-review-service-"));
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory,
      emit: () => undefined,
      warn: () => undefined,
    });
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

    await service.detachReview(DOCUMENT_ID);
    const restarted = new ReviewApplicationService({
      authority,
      sidecarDirectory,
      emit: () => undefined,
      warn: () => undefined,
    });
    await restarted.reattachReview(DOCUMENT_ID, DOCUMENT_PATH, baseline);
    assert.deepEqual(
      restarted.getOutstandingChunks(DOCUMENT_ID)?.map((chunk) => chunk.chunkId),
      [first.chunkId, second.chunkId],
      "restart must preserve both stable suggestion identities",
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
    const authority = new DocumentAuthority(baseline);
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-review-service-")),
      emit: () => undefined,
      warn: () => undefined,
    });
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

  it("preserves a saved held review when only a later unsaved edit is discarded", async function () {
    // "Don't save" discards the unsaved delta the prompt names. A held review
    // that was already saved — its sidecar fence matches the bytes on disk —
    // is separately persisted state and is not the discard's to destroy.
    const baseline = "alpha\nbeta\n";
    const proposed = "ALPHA\nbeta\n";
    const authority = new DocumentAuthority(baseline);
    const sidecarDirectory = mkdtempSync(join(tmpdir(), "zettlr-review-service-"));
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory,
      emit: () => undefined,
      warn: () => undefined,
    });
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

    await service.discardReview(DOCUMENT_ID, DOCUMENT_PATH, proposed);
    assert.equal(
      service.getReview(DOCUMENT_ID)?.reviewId,
      submitted.reviewId,
      "discarding the unsaved edit must not destroy the saved held review",
    );
    assert.equal(
      (await service.readSidecar(DOCUMENT_PATH))?.reviewId,
      submitted.reviewId,
      "the saved review's sidecar must survive the discard",
    );
  });

  it("owns editor reconciliation, save fencing, and detached reattachment", async function () {
    const baseline = "alpha\nbeta\n";
    const proposed = "ALPHA\nbeta\n";
    const edited = "ALPHA\nBETA edited\n";
    const authority = new DocumentAuthority(baseline);
    const sidecarDirectory = mkdtempSync(join(tmpdir(), "zettlr-review-service-"));
    const service = new ReviewApplicationService({
      authority,
      sidecarDirectory,
      emit: () => undefined,
      warn: () => undefined,
    });
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

    await service.detachReview(DOCUMENT_ID);
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    authority.close();
    authority.reopen();
    const restored = await service.reattachReview(DOCUMENT_ID, DOCUMENT_PATH, proposed);
    assert.equal(restored?.workingText, edited);
    assert.equal(service.getReview(DOCUMENT_ID)?.reviewId, submitted.reviewId);

    await service.discardReview(DOCUMENT_ID, DOCUMENT_PATH, baseline);
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
    await service.detachReview(DOCUMENT_ID);
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    await service.discardReview(DOCUMENT_ID, DOCUMENT_PATH, baseline);
    assert.equal(await service.readSidecar(DOCUMENT_PATH), undefined);
  });
});
