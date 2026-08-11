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

    const chunk = service.reviewStore.getOutstandingChunks(DOCUMENT_ID, proposed)![0];
    const decided = await service.decideChunk(
      submitted.reviewId,
      chunk.chunkId,
      "accept",
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
    await service.applyWorkingTextEdit(DOCUMENT_ID, edited, () => {
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
