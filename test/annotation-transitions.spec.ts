/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation transitions and the transaction boundary
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Two halves of one claim.
 *
 *                  The first half is what an annotation mutation MEANS: the
 *                  pure transitions, driven directly, proving the state
 *                  machine and the two rules the transports must not be
 *                  trusted with — lifecycle is the owner's (I3), and the
 *                  quoted text is never rewritten (I1).
 *
 *                  The second half is the ordering: the real application
 *                  service, a real temporary sidecar directory, and a real
 *                  document authority. It proves that persistence precedes
 *                  the in-memory commit (I2) by making the write fail and
 *                  then reading both memory and disk back; that concurrent
 *                  mutations on one document serialize, by giving them a
 *                  reason to disagree if they do not; and that a review
 *                  mutation and an annotation mutation are one transaction
 *                  over one sidecar rather than two writers of one file.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { chmodSync } from "fs";
import { createPatch } from "diff";
import type { AnnotationSet, TextAnnotation } from "@dts/common/annotation-domain";
import { sha256Text } from "@common/util/sha256";
import {
  emptyAnnotationSet,
  prepareAnnotationCreation,
  prepareAnnotationDeletion,
  prepareAnnotationMessage,
  prepareAnnotationReattachment,
  prepareAnnotationReopen,
  prepareAnnotationResolution,
  type AnnotationMutationPlan,
  type AnnotationTransitionError,
} from "source/app/service-providers/documents/annotation-transitions";
import type {
  AnnotationFailure,
  CollaborationApplicationService,
} from "source/app/service-providers/documents/document-collaboration-application-service";
import {
  committed,
  harness as sharedHarness,
  reopened as sharedReopened,
  type Harness,
} from "./collaboration-test-authority";

const DOCUMENT_ID = "doc-annotated";
const DOCUMENT_PATH = "/tmp/annotation-transactions-note.md";
const BASELINE = "The quick brown fox\njumps over the lazy dog\n";
/** "brown fox", the stretch every fixture comments on. */
const TARGET = { from: 10, to: 19 };
const INSTRUCTION = "Say what kind of fox this is.";

// Binds this file's document identity once so call sites below only ever
// name what varies (diskText, sidecarDirectory) — never documentId/Path, and
// never a bare positional string that could be either.
function harness(options: { diskText?: string; sidecarDirectory?: string } = {}): Harness {
  return sharedHarness({
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    tmpPrefix: "zettlr-annotation-transactions-",
    diskText: BASELINE,
    ...options,
  });
}

/** A second process over the same sidecar directory: a real reload. */
function reopened(options: { sidecarDirectory: string; diskText: string }): Harness {
  return sharedReopened({
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    ...options,
  });
}

function refused(result: object | undefined): AnnotationFailure {
  assert.ok(result !== undefined && "ok" in result, "expected a refusal, got a committed result");
  return result as AnnotationFailure;
}

function planned<T>(
  result: AnnotationMutationPlan<T> | AnnotationTransitionError,
): AnnotationMutationPlan<T> {
  if ("ok" in result) {
    assert.fail(`expected a plan, got ${result.code}: ${result.message}`);
  }
  return result;
}

function rejected(
  result: AnnotationMutationPlan<unknown> | AnnotationTransitionError,
): AnnotationTransitionError {
  assert.ok("ok" in result, "expected a refusal, got a plan");
  return result;
}

/** One annotation over "brown fox", built by the only constructor there is. */
function oneAnnotation(): AnnotationSet {
  return planned(
    prepareAnnotationCreation({
      annotations: emptyAnnotationSet(),
      actor: "owner",
      documentId: DOCUMENT_ID,
      workingText: BASELINE,
      from: TARGET.from,
      to: TARGET.to,
      instruction: INSTRUCTION,
      expectedAnnotationGeneration: 0,
    }),
  ).nextAnnotations;
}

function only(annotations: AnnotationSet): TextAnnotation {
  assert.equal(annotations.items.length, 1);
  return annotations.items[0];
}

async function createOne(
  service: CollaborationApplicationService,
  overrides: Partial<{ from: number; to: number; instruction: string; generation: number }> = {},
): Promise<TextAnnotation> {
  return committed(
    await service.createAnnotation({
      documentId: DOCUMENT_ID,
      actor: "owner",
      from: overrides.from ?? TARGET.from,
      to: overrides.to ?? TARGET.to,
      instruction: overrides.instruction ?? INSTRUCTION,
      expectedAnnotationGeneration: overrides.generation ?? 0,
    }),
  );
}

describe("pure annotation transitions", function () {
  it("cuts the quoted text from the buffer and makes the instruction the thread's first turn", function () {
    const annotation = only(oneAnnotation());
    assert.deepEqual(annotation.anchor, {
      state: "range",
      from: 10,
      to: 19,
      quotedText: "brown fox",
    });
    assert.equal(annotation.messages.length, 1);
    assert.equal(annotation.messages[0].author, "owner");
    assert.equal(annotation.messages[0].text, INSTRUCTION);
    assert.equal(annotation.state, "open");
    assert.deepEqual(annotation.proposalActions, []);
    assert.equal(annotation.createdAt, annotation.updatedAt);
    assert.equal(annotation.resolvedAt, undefined);
  });

  it("refuses a target that is empty, backwards, or outside the document", function () {
    for (const [from, to] of [
      [12, 12],
      [19, 10],
      [10, BASELINE.length + 1],
      [-1, 5],
    ]) {
      assert.equal(
        rejected(
          prepareAnnotationCreation({
            annotations: emptyAnnotationSet(),
            actor: "owner",
            documentId: DOCUMENT_ID,
            workingText: BASELINE,
            from,
            to,
            instruction: INSTRUCTION,
            expectedAnnotationGeneration: 0,
          }),
        ).code,
        "INVALID_PARAMS",
        `expected ${from}..${to} to be refused`,
      );
    }
  });

  it("refuses an annotation with no instruction, because the instruction is the annotation", function () {
    assert.equal(
      rejected(
        prepareAnnotationCreation({
          annotations: emptyAnnotationSet(),
          actor: "owner",
          documentId: DOCUMENT_ID,
          workingText: BASELINE,
          from: TARGET.from,
          to: TARGET.to,
          instruction: "   \n ",
          expectedAnnotationGeneration: 0,
        }),
      ).code,
      "INVALID_PARAMS",
    );
  });

  it("refuses every lifecycle move an agent asks for, and leaves the set untouched (I3)", function () {
    const annotations = oneAnnotation();
    const annotationId = only(annotations).annotationId;
    const before = structuredClone(annotations);
    const asked = [
      prepareAnnotationResolution({
        annotations,
        actor: "agent",
        annotationId,
        expectedAnnotationGeneration: 1,
      }),
      prepareAnnotationReopen({
        annotations,
        actor: "agent",
        annotationId,
        expectedAnnotationGeneration: 1,
      }),
      prepareAnnotationDeletion({
        annotations,
        actor: "agent",
        annotationId,
        expectedAnnotationGeneration: 1,
      }),
      prepareAnnotationReattachment({
        annotations,
        actor: "agent",
        annotationId,
        from: 0,
        to: 3,
        workingText: BASELINE,
        expectedAnnotationGeneration: 1,
      }),
      prepareAnnotationCreation({
        annotations,
        actor: "agent",
        documentId: DOCUMENT_ID,
        workingText: BASELINE,
        from: 0,
        to: 3,
        instruction: "agent tries to open a thread",
        expectedAnnotationGeneration: 1,
      }),
    ];
    for (const result of asked) {
      assert.equal(rejected(result).code, "ANNOTATION_OWNER_ONLY");
    }
    assert.deepEqual(annotations, before);
  });

  it("lets an agent reply, and stamps the message with the actor rather than the caller's word", function () {
    const annotations = oneAnnotation();
    const plan = planned(
      prepareAnnotationMessage({
        annotations,
        actor: "agent",
        annotationId: only(annotations).annotationId,
        text: "It is a red fox.",
        clientRequestId: "agent-reply-1",
        expectedAnnotationGeneration: 1,
      }),
    );
    assert.equal(plan.response.author, "agent");
    assert.equal(
      plan.response.author === "agent" ? plan.response.clientRequestId : undefined,
      "agent-reply-1",
    );
    assert.equal(only(plan.nextAnnotations).messages.length, 2);
    assert.equal(plan.nextAnnotations.generation, 2);
  });

  it("answers a replayed clientRequestId with the message it already posted, without a second turn", function () {
    const annotations = oneAnnotation();
    const annotationId = only(annotations).annotationId;
    const first = planned(
      prepareAnnotationMessage({
        annotations,
        actor: "agent",
        annotationId,
        text: "It is a red fox.",
        clientRequestId: "agent-reply-1",
        expectedAnnotationGeneration: 1,
      }),
    );
    // The retry necessarily carries the generation the first post moved past.
    const retry = planned(
      prepareAnnotationMessage({
        annotations: first.nextAnnotations,
        actor: "agent",
        annotationId,
        text: "It is a red fox.",
        clientRequestId: "agent-reply-1",
        expectedAnnotationGeneration: 1,
      }),
    );
    assert.deepEqual(retry.response, first.response);
    assert.equal(only(retry.nextAnnotations).messages.length, 2);
    assert.equal(retry.nextAnnotations.generation, first.nextAnnotations.generation);
    assert.deepEqual(retry.events, []);
  });

  it("refuses an agent message with no request id, so a retry can never be told apart from a new turn", function () {
    const annotations = oneAnnotation();
    assert.equal(
      rejected(
        prepareAnnotationMessage({
          annotations,
          actor: "agent",
          annotationId: only(annotations).annotationId,
          text: "It is a red fox.",
          expectedAnnotationGeneration: 1,
        }),
      ).code,
      "INVALID_PARAMS",
    );
  });

  it("fences every mutation on the annotation generation alone", function () {
    const annotations = oneAnnotation();
    assert.equal(
      rejected(
        prepareAnnotationResolution({
          annotations,
          actor: "owner",
          annotationId: only(annotations).annotationId,
          expectedAnnotationGeneration: 0,
        }),
      ).code,
      "ANNOTATION_GENERATION_MISMATCH",
    );
  });

  it("resolves, refuses a second resolution, refuses a reply, and reopens", function () {
    const annotations = oneAnnotation();
    const annotationId = only(annotations).annotationId;
    const resolved = planned(
      prepareAnnotationResolution({
        annotations,
        actor: "owner",
        annotationId,
        expectedAnnotationGeneration: 1,
      }),
    ).nextAnnotations;
    assert.equal(only(resolved).state, "resolved");
    assert.equal(typeof only(resolved).resolvedAt, "string");

    assert.equal(
      rejected(
        prepareAnnotationResolution({
          annotations: resolved,
          actor: "owner",
          annotationId,
          expectedAnnotationGeneration: 2,
        }),
      ).code,
      "ANNOTATION_RESOLVED",
    );
    assert.equal(
      rejected(
        prepareAnnotationMessage({
          annotations: resolved,
          actor: "agent",
          annotationId,
          text: "one more thought",
          clientRequestId: "late",
          expectedAnnotationGeneration: 2,
        }),
      ).code,
      "ANNOTATION_RESOLVED",
    );

    const reopenedSet = planned(
      prepareAnnotationReopen({
        annotations: resolved,
        actor: "owner",
        annotationId,
        expectedAnnotationGeneration: 2,
      }),
    ).nextAnnotations;
    assert.equal(only(reopenedSet).state, "open");
    assert.equal(only(reopenedSet).resolvedAt, undefined);
    assert.equal(reopenedSet.generation, 3);
  });

  it("reattaches to a range the owner picked and keeps the original quoted text (I1)", function () {
    const annotations = oneAnnotation();
    const plan = planned(
      prepareAnnotationReattachment({
        annotations,
        actor: "owner",
        annotationId: only(annotations).annotationId,
        from: 0,
        to: 9,
        workingText: BASELINE,
        expectedAnnotationGeneration: 1,
      }),
    );
    assert.deepEqual(only(plan.nextAnnotations).anchor, {
      state: "range",
      from: 0,
      to: 9,
      quotedText: "brown fox",
    });
  });

  it("deletes the annotation it names and nothing else", function () {
    const first = oneAnnotation();
    const second = planned(
      prepareAnnotationCreation({
        annotations: first,
        actor: "owner",
        documentId: DOCUMENT_ID,
        workingText: BASELINE,
        from: 4,
        to: 9,
        instruction: "and this word",
        expectedAnnotationGeneration: 1,
      }),
    ).nextAnnotations;
    const plan = planned(
      prepareAnnotationDeletion({
        annotations: second,
        actor: "owner",
        annotationId: second.items[0].annotationId,
        expectedAnnotationGeneration: 2,
      }),
    );
    assert.deepEqual(
      plan.nextAnnotations.items.map((item) => item.annotationId),
      [second.items[1].annotationId],
    );
  });

  it("leaves its input untouched whatever it decides", function () {
    const annotations = oneAnnotation();
    const before = structuredClone(annotations);
    const annotationId = only(annotations).annotationId;
    prepareAnnotationResolution({
      annotations,
      actor: "owner",
      annotationId,
      expectedAnnotationGeneration: 1,
    });
    prepareAnnotationMessage({
      annotations,
      actor: "owner",
      annotationId,
      text: "a reply",
      expectedAnnotationGeneration: 1,
    });
    prepareAnnotationDeletion({
      annotations,
      actor: "owner",
      annotationId,
      expectedAnnotationGeneration: 1,
    });
    prepareAnnotationReattachment({
      annotations,
      actor: "owner",
      annotationId,
      from: 0,
      to: 3,
      workingText: BASELINE,
      expectedAnnotationGeneration: 1,
    });
    assert.deepEqual(annotations, before);
  });
});

describe("the annotation transaction boundary", function () {
  it("has the mutation on disk before any reader can see it in memory (I2)", async function () {
    const { service, sidecarDirectory, emitted } = harness();
    const annotation = await createOne(service);

    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.deepEqual(persisted?.annotations, service.getAnnotations(DOCUMENT_ID));
    assert.equal(persisted?.annotations.generation, 1);
    assert.equal(persisted?.annotations.items[0].annotationId, annotation.annotationId);
    assert.equal(persisted?.review, null);
    assert.deepEqual(
      emitted.map((entry) => entry.event),
      ["annotation.created"],
    );
    assert.equal(emitted[0].payload.annotationGeneration, 1);
    assert.equal(emitted[0].payload.annotationId, annotation.annotationId);

    // A second process over the same directory: what a restart would read.
    const restarted = reopened({ sidecarDirectory, diskText: BASELINE });
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      BASELINE,
    );
    assert.deepEqual(restored?.annotations.items, persisted?.annotations.items);
  });

  it("commits neither memory nor disk when the sidecar write fails, and both agree on reload", async function () {
    const { service, sidecarDirectory } = harness();
    const first = await createOne(service);
    const beforeMemory = structuredClone(service.getAnnotations(DOCUMENT_ID));
    const beforeDisk = await service.readSidecar(DOCUMENT_PATH);

    chmodSync(sidecarDirectory, 0o500);
    const failure = refused(
      await service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: 4,
        to: 9,
        instruction: "a second thread that must not survive",
        expectedAnnotationGeneration: 1,
      }),
    );
    chmodSync(sidecarDirectory, 0o700);

    assert.equal(failure.code, "PERSISTENCE_FAILED");
    assert.deepEqual(service.getAnnotations(DOCUMENT_ID), beforeMemory);
    assert.deepEqual(await service.readSidecar(DOCUMENT_PATH), beforeDisk);

    const restarted = reopened({ sidecarDirectory, diskText: BASELINE });
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      BASELINE,
    );
    assert.deepEqual(
      restored?.annotations.items.map((item) => item.annotationId),
      [first.annotationId],
    );
    assert.equal(restored?.annotations.generation, 1);
  });

  it("serializes two concurrent mutations that were formed against the same generation", async function () {
    const { service, sidecarDirectory } = harness();
    const [left, right] = await Promise.all([
      service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: TARGET.from,
        to: TARGET.to,
        instruction: "the first thread",
        expectedAnnotationGeneration: 0,
      }),
      service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: 4,
        to: 9,
        instruction: "the second thread",
        expectedAnnotationGeneration: 0,
      }),
    ]);

    // Interleaved, both would read generation 0 and both would apply.
    const outcomes = [left, right].map((result) =>
      "ok" in result ? (result as AnnotationFailure).code : "committed",
    );
    assert.deepEqual(outcomes.slice().sort(), ["ANNOTATION_GENERATION_MISMATCH", "committed"]);

    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(persisted?.annotations.items.length, 1);
    assert.equal(persisted?.annotations.generation, 1);

    const restarted = reopened({ sidecarDirectory, diskText: BASELINE });
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      BASELINE,
    );
    assert.equal(restored?.annotations.items.length, 1);
  });

  it("serializes a review mutation against an annotation mutation, and one sidecar carries both", async function () {
    const { service, authority, sidecarDirectory } = harness();
    const proposed = BASELINE.replace("lazy dog", "LAZY DOG");

    // The two counters are independent, so neither call can fence the other
    // out: serialized, both must land, and one sidecar must hold both.
    const [annotationResult, proposalResult] = await Promise.all([
      service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: TARGET.from,
        to: TARGET.to,
        instruction: INSTRUCTION,
        expectedAnnotationGeneration: 0,
      }),
      service.submitProposal({
        documentId: DOCUMENT_ID,
        baselineSha256: sha256Text(BASELINE),
        claims: [
          {
            patch: createPatch(DOCUMENT_PATH, BASELINE, proposed, "", "", { context: 3 }),
            description: "shout at the dog",
          },
        ],
        clientRequestId: "concurrent-proposal",
        expectedReviewGeneration: 0,
      }),
    ]);
    const annotation = committed(annotationResult);
    assert.equal(proposalResult.ok, true);

    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(persisted?.annotations.items.length, 1);
    assert.equal(persisted?.annotations.items[0].annotationId, annotation.annotationId);
    assert.equal(persisted?.review?.packets.length, 1);
    assert.equal(persisted?.review?.generation, 1);
    assert.equal(persisted?.workingText, authority.readWorkingText(DOCUMENT_ID));
    assert.deepEqual(persisted?.annotations, service.getAnnotations(DOCUMENT_ID));

    const restarted = reopened({ sidecarDirectory, diskText: BASELINE });
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      BASELINE,
    );
    assert.equal(restored?.annotations.items.length, 1);
    assert.equal(restored?.review?.packets.length, 1);
  });

  it("carries an anchor through the owner's typing in the same transaction as the text", async function () {
    const { service, authority } = harness();
    const annotation = await createOne(service);
    const edit = authority.ownerEdit({ from: 0, to: 0, insert: "Once upon a time. " });
    await service.applyWorkingTextEdit(
      DOCUMENT_ID,
      edit.nextText,
      edit.changes,
      edit.commit,
    );

    const moved = service.getAnnotations(DOCUMENT_ID).items[0];
    assert.equal(moved.annotationId, annotation.annotationId);
    assert.deepEqual(moved.anchor, {
      state: "range",
      from: TARGET.from + 18,
      to: TARGET.to + 18,
      quotedText: "brown fox",
    });
    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.deepEqual(persisted?.annotations, service.getAnnotations(DOCUMENT_ID));
    assert.equal(persisted?.workingText, edit.nextText);
    assert.equal(
      edit.nextText.slice(moved.anchor.from, (moved.anchor as { to: number }).to),
      "brown fox",
    );
  });

  it("never blocks a save on an open annotation, and moves the fence with the file (I5)", async function () {
    const { service, authority, sidecarDirectory } = harness();
    await createOne(service);
    const edit = authority.ownerEdit({ from: 0, to: 0, insert: "Once upon a time. " });
    await service.applyWorkingTextEdit(DOCUMENT_ID, edit.nextText, edit.changes, edit.commit);

    const savedSha256 = sha256Text(edit.nextText);
    const preparation = await service.prepareSave(DOCUMENT_ID, savedSha256);
    assert.ok(preparation !== undefined);
    assert.equal(preparation.survivesSave, true);
    assert.equal(preparation.reviewId, undefined);
    authority.setDiskText(edit.nextText);
    await service.completeSave(preparation, savedSha256);

    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(persisted?.diskFenceSha256, savedSha256);
    assert.equal(persisted?.annotations.items.length, 1);

    // The saved bytes must not read as drift when the file is opened again.
    await service.detachCollaboration(DOCUMENT_ID);
    const restarted = reopened({ sidecarDirectory, diskText: edit.nextText });
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      edit.nextText,
    );
    assert.equal(restored?.annotations.items[0].anchor.state, "range");
    assert.deepEqual(restored?.annotations.items[0].anchor, {
      state: "range",
      from: TARGET.from + 18,
      to: TARGET.to + 18,
      quotedText: "brown fox",
    });
  });

  it("orphans annotations on external drift instead of losing them (I6)", async function () {
    const { service, sidecarDirectory } = harness();
    const annotation = await createOne(service);
    const reply = committed(
      await service.addAnnotationMessage({
        documentId: DOCUMENT_ID,
        annotationId: annotation.annotationId,
        actor: "agent",
        text: "It is a red fox.",
        clientRequestId: "reply-1",
        expectedAnnotationGeneration: 1,
      }),
    );
    await service.detachCollaboration(DOCUMENT_ID);

    const drifted = "Something else entirely.\nWritten by another program.\n";
    const restarted = reopened({ sidecarDirectory, diskText: drifted });
    const restored = await restarted.service.reattachCollaboration(
      DOCUMENT_ID,
      DOCUMENT_PATH,
      drifted,
    );

    const survivor = only(restored!.annotations);
    assert.equal(survivor.annotationId, annotation.annotationId);
    assert.deepEqual(survivor.anchor, {
      state: "orphaned",
      quotedText: "brown fox",
      reason: "external-drift",
    });
    assert.deepEqual(
      survivor.messages.map((message) => message.text),
      [INSTRUCTION, reply.text],
    );
    // The sidecar survives the drift the review does not.
    const persisted = await restarted.service.readSidecar(DOCUMENT_PATH);
    assert.equal(persisted?.annotations.items.length, 1);
    assert.equal(persisted?.diskFenceSha256, sha256Text(drifted));
  });

  it("keeps a document's annotations across a review mutation that rewrites its text", async function () {
    const { service, authority } = harness();
    const annotation = await createOne(service);
    const proposed = BASELINE.replace("The quick", "THE QUICK");
    const submitted = await service.submitProposal({
      documentId: DOCUMENT_ID,
      baselineSha256: sha256Text(BASELINE),
      claims: [
        {
          patch: createPatch(DOCUMENT_PATH, BASELINE, proposed, "", "", { context: 3 }),
          description: "shout the opening",
        },
      ],
      clientRequestId: "review-alongside-annotation",
      expectedReviewGeneration: 0,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    const afterProposal = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(afterProposal?.annotations.items.length, 1);
    assert.equal(afterProposal?.annotations.items[0].annotationId, annotation.annotationId);

    const accepted = await service.acceptAllChunks(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(authority.readWorkingText(DOCUMENT_ID)!),
    });
    assert.equal("ok" in accepted && accepted.ok, true);

    const afterAccept = await service.readSidecar(DOCUMENT_PATH);
    assert.equal(afterAccept?.annotations.items.length, 1);
    assert.deepEqual(afterAccept?.annotations, service.getAnnotations(DOCUMENT_ID));
    assert.equal(afterAccept?.annotations.items[0].anchor.quotedText, "brown fox");
  });

  it("keeps counting after the last annotation goes, so a stale fence stays stale", async function () {
    const { service } = harness();
    const annotation = await createOne(service);
    committed(
      await service.deleteAnnotation({
        documentId: DOCUMENT_ID,
        annotationId: annotation.annotationId,
        actor: "owner",
        expectedAnnotationGeneration: 1,
      }),
    );
    assert.deepEqual(service.getAnnotations(DOCUMENT_ID), { generation: 2, items: [] });
    // The sidecar has nothing left to keep, so the store removed the file.
    assert.equal(await service.readSidecar(DOCUMENT_PATH), undefined);
    assert.equal(
      refused(
        await service.createAnnotation({
          documentId: DOCUMENT_ID,
          actor: "owner",
          from: TARGET.from,
          to: TARGET.to,
          instruction: "formed before the delete landed",
          expectedAnnotationGeneration: 1,
        }),
      ).code,
      "ANNOTATION_GENERATION_MISMATCH",
    );
    assert.equal((await createOne(service, { generation: 2 })).anchor.quotedText, "brown fox");
  });

  it("keeps the threads and orphans the anchors when the owner discards the bytes they described", async function () {
    const { service, authority } = harness();
    const annotation = await createOne(service);
    const edit = authority.ownerEdit({ from: 0, to: 0, insert: "An unsaved thought. " });
    await service.applyWorkingTextEdit(DOCUMENT_ID, edit.nextText, edit.changes, edit.commit);

    await service.discardCollaboration(DOCUMENT_ID, DOCUMENT_PATH, BASELINE);

    const survivor = only(service.getAnnotations(DOCUMENT_ID));
    assert.equal(survivor.annotationId, annotation.annotationId);
    assert.deepEqual(survivor.anchor, {
      state: "orphaned",
      quotedText: "brown fox",
      reason: "unmapped-document-change",
    });
    assert.equal(survivor.messages[0].text, INSTRUCTION);
    const persisted = await service.readSidecar(DOCUMENT_PATH);
    assert.deepEqual(persisted?.annotations, service.getAnnotations(DOCUMENT_ID));
    assert.equal(persisted?.workingText, BASELINE);
  });

  it("refuses an annotation mutation on a closed document without touching the sidecar", async function () {
    const { service, authority } = harness();
    await createOne(service);
    const before = await service.readSidecar(DOCUMENT_PATH);
    authority.close();

    const failure = refused(
      await service.createAnnotation({
        documentId: DOCUMENT_ID,
        actor: "owner",
        from: 4,
        to: 9,
        instruction: "while the document is closed",
        expectedAnnotationGeneration: 1,
      }),
    );
    assert.equal(failure.code, "DOCUMENT_CLOSED");
    assert.deepEqual(await service.readSidecar(DOCUMENT_PATH), before);
  });
});
