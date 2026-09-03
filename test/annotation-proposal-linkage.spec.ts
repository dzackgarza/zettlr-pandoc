/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Cross-section proposal linkage
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A proposal that says it answers an annotation touches two
 *                  sections of one sidecar: the review gains a packet, and
 *                  the annotation gains the record of it. This spec is about
 *                  the "or not at all" half of that.
 *
 *                  Every refusal here is checked against BOTH stores and
 *                  against the file, because a linkage that validated but
 *                  committed the review anyway, or committed the annotation
 *                  record beside a review that was never written, would pass
 *                  a test that only read one of them. The refusals are
 *                  deliberately raised late — after the review plan exists —
 *                  which is exactly the case a two-write implementation gets
 *                  wrong and a one-write implementation cannot.
 *
 *                  It also covers what a rejection owes an annotation: the
 *                  text the proposal moved comes back, and the anchor comes
 *                  back with it, through the same change set.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { chmodSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPatch } from "diff";
import type { AgentEventType } from "@dts/common/agent-api";
import type { TextAnnotation } from "@dts/common/annotation-domain";
import { sha256Text } from "@common/util/sha256";
import {
  CollaborationApplicationService,
  type AgentEventPayload,
  type AnnotationFailure,
} from "source/app/service-providers/documents/document-collaboration-application-service";
import { DocumentAuthority } from "./collaboration-test-authority";

const DOCUMENT_ID = "doc-linked";
const DOCUMENT_PATH = "/tmp/annotation-linkage-note.md";
const BASELINE = "The quick brown fox\njumps over the lazy dog\n";
const PROPOSED = "The quick brown fox\nleaps over the lazy dog\n";
/** "brown fox" — what the owner's instruction is about. */
const TARGET = { from: 10, to: 19 };
const INSTRUCTION = "Make this fox move more vividly.";

class LinkedDocumentAuthority extends DocumentAuthority {
  constructor(diskText = BASELINE) {
    super(diskText, DOCUMENT_ID, DOCUMENT_PATH);
  }
}

interface Harness {
  authority: LinkedDocumentAuthority;
  service: CollaborationApplicationService;
  sidecarDirectory: string;
  emitted: Array<{ event: AgentEventType; payload: AgentEventPayload }>;
}

function harness(sidecarDirectory?: string, diskText = BASELINE): Harness {
  const authority = new LinkedDocumentAuthority(diskText);
  const emitted: Array<{ event: AgentEventType; payload: AgentEventPayload }> = [];
  const directory = sidecarDirectory ?? mkdtempSync(join(tmpdir(), "zettlr-annotation-linkage-"));
  return {
    authority,
    emitted,
    sidecarDirectory: directory,
    service: new CollaborationApplicationService({
      authority,
      sidecarDirectory: directory,
      emit: (event, payload) => emitted.push({ event, payload }),
      warn: () => undefined,
    }),
  };
}

function committed<T extends object>(result: T | AnnotationFailure): T {
  if ("ok" in result) {
    const failure = result as AnnotationFailure;
    assert.fail(`expected a committed annotation, got ${failure.code}: ${failure.message}`);
  }
  return result;
}

function patch(oldText: string, newText: string): string {
  return createPatch(DOCUMENT_PATH, oldText, newText, "", "", { context: 3 });
}

async function annotated(service: CollaborationApplicationService): Promise<TextAnnotation> {
  return committed(
    await service.createAnnotation({
      documentId: DOCUMENT_ID,
      actor: "owner",
      from: TARGET.from,
      to: TARGET.to,
      instruction: INSTRUCTION,
      expectedAnnotationGeneration: 0,
    }),
  );
}

function submit(
  service: CollaborationApplicationService,
  addressesAnnotationIds: string[],
  clientRequestId = "linked-proposal",
  texts: { before: string; after: string } = { before: BASELINE, after: PROPOSED },
) {
  return service.submitProposal({
    documentId: DOCUMENT_ID,
    baselineSha256: sha256Text(texts.before),
    claims: [
      {
        patch: patch(texts.before, texts.after),
        description: "a livelier verb",
        addressesAnnotationIds,
      },
    ],
    clientRequestId,
    expectedReviewGeneration: 0,
  });
}

describe("cross-section proposal linkage", function () {
  it("records the packet and the annotation's action in one sidecar", async function () {
    const { service, emitted, sidecarDirectory } = harness();
    const annotation = await annotated(service);
    const beforeGeneration = service.getAnnotations(DOCUMENT_ID).generation;

    const submitted = await submit(service, [annotation.annotationId]);
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const persisted = await service.readSidecar(DOCUMENT_PATH);
    const action = persisted?.annotations.items[0].proposalActions[0];
    assert.equal(persisted?.review?.packets.length, 1);
    assert.equal(action?.packetId, submitted.packetId);
    assert.equal(action?.reviewId, submitted.reviewId);
    assert.equal(typeof action?.linkedAt, "string");

    // The two counters move independently, and both moved here.
    assert.equal(persisted?.review?.generation, 1);
    assert.equal(persisted?.annotations.generation, beforeGeneration + 1);
    assert.deepEqual(persisted?.annotations, service.getAnnotations(DOCUMENT_ID));
    assert.ok(
      emitted.some(
        (entry) =>
          entry.event === "annotation.proposal-linked" &&
          entry.payload.packetId === submitted.packetId,
      ),
    );

    const restarted = harness(sidecarDirectory);
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      BASELINE,
    );
    assert.equal(restored?.annotations.items[0].proposalActions[0].packetId, submitted.packetId);
    assert.equal(restored?.review?.packets[0].packetId, submitted.packetId);
  });

  it("commits neither half when the proposal addresses an annotation the document does not have", async function () {
    const { service, authority } = harness();
    const annotation = await annotated(service);
    const before = await service.readSidecar(DOCUMENT_PATH);

    const refused = await submit(service, [annotation.annotationId, "no-such-annotation"]);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? undefined : refused.code, "ANNOTATION_NOT_FOUND");

    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), BASELINE);
    assert.deepEqual(await service.readSidecar(DOCUMENT_PATH), before);
    assert.deepEqual(service.getAnnotations(DOCUMENT_ID).items[0].proposalActions, []);
  });

  it("refuses a proposal against a resolved thread and leaves the review unopened", async function () {
    const { service, authority } = harness();
    const annotation = await annotated(service);
    committed(
      await service.resolveAnnotation({
        documentId: DOCUMENT_ID,
        annotationId: annotation.annotationId,
        actor: "owner",
        expectedAnnotationGeneration: 1,
      }),
    );
    const before = await service.readSidecar(DOCUMENT_PATH);

    const refused = await submit(service, [annotation.annotationId]);
    assert.equal(refused.ok ? undefined : refused.code, "ANNOTATION_RESOLVED");
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), BASELINE);
    assert.deepEqual(await service.readSidecar(DOCUMENT_PATH), before);
  });

  it("refuses a proposal against an orphaned target, whose text the document no longer has", async function () {
    const { service, sidecarDirectory } = harness();
    await annotated(service);
    await service.detachCollaboration(DOCUMENT_ID);

    const drifted = "A different document altogether.\n";
    const restarted = harness(sidecarDirectory, drifted);
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      drifted,
    );
    restarted.authority.reloadFromDisk();
    const orphan = restored!.annotations.items[0];
    assert.equal(orphan.anchor.state, "orphaned");
    const before = await restarted.service.readSidecar(DOCUMENT_PATH);

    const refused = await restarted.service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(drifted),
      claims: [
        {
          patch: patch(drifted, "A different document entirely.\n"),
          description: "a livelier adverb",
          addressesAnnotationIds: [orphan.annotationId],
        },
      ],
      clientRequestId: "linked-to-orphan",
      expectedReviewGeneration: 0,
    });
    assert.equal(refused.ok ? undefined : refused.code, "ANNOTATION_ORPHANED");
    assert.equal(restarted.service.getReview(DOCUMENT_ID), undefined);
    assert.deepEqual(await restarted.service.readSidecar(DOCUMENT_PATH), before);
  });

  it("lands neither the packet nor the action when the one write fails", async function () {
    const { service, authority, sidecarDirectory } = harness();
    const annotation = await annotated(service);
    const before = await service.readSidecar(DOCUMENT_PATH);

    chmodSync(sidecarDirectory, 0o500);
    const refused = await submit(service, [annotation.annotationId]);
    chmodSync(sidecarDirectory, 0o700);

    assert.equal(refused.ok ? undefined : refused.code, "PERSISTENCE_FAILED");
    assert.equal(service.getReview(DOCUMENT_ID), undefined);
    assert.deepEqual(service.getAnnotations(DOCUMENT_ID).items[0].proposalActions, []);
    assert.equal(authority.readWorkingText(DOCUMENT_ID), BASELINE);
    assert.deepEqual(await service.readSidecar(DOCUMENT_PATH), before);
  });

  it("restores the annotation's target when the owner rejects the proposal that moved it", async function () {
    const { service, authority } = harness();
    // The annotation is on the second line, which the claim rewrites in
    // front of, so its coordinates genuinely move and genuinely come back.
    const annotation = committed(
      await service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: BASELINE.indexOf("lazy dog"),
        to: BASELINE.indexOf("lazy dog") + "lazy dog".length,
        instruction: "Is the dog really lazy?",
        expectedAnnotationGeneration: 0,
      }),
    );
    const originalAnchor = { ...annotation.anchor };

    const submitted = await submit(service, [annotation.annotationId], "moves-the-anchor", {
      before: BASELINE,
      after: BASELINE.replace("jumps", "bounds"),
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }
    const moved = service.getAnnotations(DOCUMENT_ID).items[0].anchor;
    assert.notDeepEqual(moved, originalAnchor);
    assert.equal(
      authority.readWorkingText(DOCUMENT_ID)!.slice(
        (moved as { from: number }).from,
        (moved as { to: number }).to,
      ),
      "lazy dog",
    );

    const chunks = service.getOutstandingChunks(DOCUMENT_ID)!;
    assert.equal(chunks.length, 1);
    const rejected = await service.decideChunk(submitted.reviewId, chunks[0].chunkId, "reject", {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(authority.readWorkingText(DOCUMENT_ID)!),
    });
    assert.equal("ok" in rejected && rejected.ok, true);

    assert.equal(authority.readWorkingText(DOCUMENT_ID), BASELINE);
    const restoredAnchor = service.getAnnotations(DOCUMENT_ID).items[0].anchor;
    assert.deepEqual(restoredAnchor, originalAnchor);
    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.deepEqual(persisted?.annotations, service.getAnnotations(DOCUMENT_ID));
    // The link is a ledger entry, not a consequence of the text: rejecting
    // the proposal does not unsay that it was made.
    assert.equal(
      persisted?.annotations.items[0].proposalActions[0].packetId,
      submitted.packetId,
    );
  });

  it("treats a replayed request id with different linkage as a different request", async function () {
    const { service } = harness();
    const first = await annotated(service);
    const second = committed(
      await service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: 4,
        to: 9,
        instruction: "and how quick is it?",
        expectedAnnotationGeneration: 1,
      }),
    );

    const submitted = await submit(service, [first.annotationId], "one-request-id");
    assert.equal(submitted.ok, true);

    const replay = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(BASELINE),
      claims: [
        {
          patch: patch(BASELINE, PROPOSED),
          description: "a livelier verb",
          addressesAnnotationIds: [second.annotationId],
        },
      ],
      clientRequestId: "one-request-id",
      expectedReviewGeneration: 0,
    });
    assert.equal(replay.ok ? undefined : replay.code, "IDEMPOTENCY_CONFLICT");
    assert.deepEqual(service.getAnnotations(DOCUMENT_ID).items[1].proposalActions, []);
  });

  it("leaves an unlinked proposal's fingerprint alone, so its own replay still answers", async function () {
    const { service } = harness();
    await annotated(service);
    const submitted = await submit(service, [], "unlinked-request");
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }
    const replay = await submit(service, [], "unlinked-request");
    assert.equal(replay.ok, true);
    assert.equal(replay.ok ? replay.packetId : undefined, submitted.packetId);
    assert.equal((await service.readSidecar(DOCUMENT_PATH))?.review?.packets.length, 1);
    assert.deepEqual(
      service.getAnnotations(DOCUMENT_ID).items[0].proposalActions,
      [],
    );
  });
});
