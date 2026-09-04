/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DocumentCollaborationSession renderer-projection tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     M4's whole claim: one DocumentCollaborationSession per
 *                  mutation, broadcast once, cached once, read by as many
 *                  panes (and the annotations panel) as care to. Two halves:
 *
 *                  - The production merge (review-diff-store.ts's
 *                    collaborationSessionFor), exercised against a real
 *                    CollaborationApplicationService and DocumentAuthority —
 *                    the exact function documents/index.ts calls to build
 *                    every DP_EVENTS.DOCUMENT_COLLABORATION broadcast. Before
 *                    this milestone, an annotation-only document (no review)
 *                    never broadcast anything at all: broadcastCollaborationState
 *                    early-returned whenever getReview() was undefined. The
 *                    first case below is a regression proof for exactly that
 *                    gap.
 *
 *                  - The renderer store (useDocumentCollaborationStore),
 *                    exercised against a real preload-bridge double
 *                    (document-collaboration-ipc-double.ts). It proves the
 *                    actual acceptance: two panes and the panel, fed from one
 *                    cached entry, see one mutation's result with exactly one
 *                    IPC read of the collaboration session — never a second
 *                    one per pane.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// Must be the first local import: it installs window.ipc as a side effect,
// before the store below reads window.ipc at its own module top level.
import { documentCollaborationIpcDouble } from "./document-collaboration-ipc-double";
import { createPinia, setActivePinia } from "pinia";
import { computed } from "vue";
import { DP_EVENTS } from "@dts/common/documents";
import type { DocumentCollaborationSession } from "@dts/common/document-collaboration";
import { useDocumentCollaborationStore } from "source/pinia/document-collaboration-store";
import {
  CollaborationApplicationService,
  type AnnotationFailure,
} from "source/app/service-providers/documents/document-collaboration-application-service";
import { collaborationSessionFor } from "source/app/service-providers/documents/review-diff-store";
import { DocumentAuthority as SharedDocumentAuthority } from "./collaboration-test-authority";
import type { TextAnnotation } from "@dts/common/annotation-domain";

const DOCUMENT_ID = "doc-multi-pane";
const DOCUMENT_PATH = "/tmp/multi-pane-note.md";
const BASELINE = "alpha\nbeta\ngamma\n";
/** "alpha" */
const TARGET = { from: 0, to: 5 };

class DocumentAuthority extends SharedDocumentAuthority {
  constructor() {
    super(BASELINE, DOCUMENT_ID, DOCUMENT_PATH);
  }
}

function committed<T extends object>(result: T | AnnotationFailure): T {
  if ("ok" in result) {
    const failure = result as AnnotationFailure;
    assert.fail(`expected a committed annotation, got ${failure.code}: ${failure.message}`);
  }
  return result;
}

function harness(): { authority: DocumentAuthority; service: CollaborationApplicationService } {
  const authority = new DocumentAuthority();
  const service = new CollaborationApplicationService({
    authority,
    sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-multi-pane-")),
    emit: () => undefined,
    warn: () => undefined,
  });
  return { authority, service };
}

/**
 * The exact merge documents/index.ts's broadcastCollaborationState calls:
 * one committed review, one committed annotation set, over the authority's
 * live working text.
 */
function sessionFor(
  authority: DocumentAuthority,
  service: CollaborationApplicationService,
): DocumentCollaborationSession {
  const workingText = authority.readWorkingText(DOCUMENT_ID);
  assert.ok(workingText !== undefined, "the document must be open to build its session");
  return collaborationSessionFor({
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    workingText,
    review: service.getReview(DOCUMENT_ID),
    annotations: service.getAnnotations(DOCUMENT_ID),
  });
}

async function annotate(service: CollaborationApplicationService): Promise<TextAnnotation> {
  return committed<TextAnnotation>(
    await service.createAnnotation({
      documentId: DOCUMENT_ID,
      actor: "owner",
      from: TARGET.from,
      to: TARGET.to,
      instruction: "Tighten this opening.",
      expectedAnnotationGeneration: 0,
    }),
  );
}

describe("collaborationSessionFor", function () {
  it("broadcasts an annotation-only document — no review required to signal", async function () {
    const { authority, service } = harness();

    const created = await annotate(service);

    // The whole point of the merge: a mutation with no review still ends the
    // pipeline in a broadcast. The prior implementation returned early
    // whenever getReview() was undefined, so an annotation-only document
    // never reached the renderer at all.
    assert.deepEqual(authority.broadcasts, ["state"]);

    const session = sessionFor(authority, service);
    assert.equal(session.documentId, DOCUMENT_ID);
    assert.equal(session.documentPath, DOCUMENT_PATH);
    assert.equal(session.review, undefined);
    assert.equal(session.annotations.generation, 1);
    assert.equal(session.annotations.items.length, 1);
    assert.equal(session.annotations.items[0].annotationId, created.annotationId);
    assert.equal(session.annotations.items[0].anchor.quotedText, "alpha");
  });
});

describe("useDocumentCollaborationStore", function () {
  beforeEach(function () {
    setActivePinia(createPinia());
    documentCollaborationIpcDouble.reset();
  });

  it("serves two panes and the panel from one cached session, with one mutation reaching all three", async function () {
    const { authority, service } = harness();
    const created = await annotate(service);
    const initialSession = sessionFor(authority, service);

    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      assert.equal(message.command, "get-collaboration-session");
      return initialSession;
    });

    const store = useDocumentCollaborationStore();
    // Three independent readers, exactly as three real components each
    // computing their own reactive view of the same store entry would.
    const pane1 = computed(() => store.sessionsByDocumentPath[DOCUMENT_PATH]);
    const pane2 = computed(() => store.sessionsByDocumentPath[DOCUMENT_PATH]);
    const panel = computed(() => store.getSession(DOCUMENT_PATH)?.annotations.items ?? []);

    // Pane 1 mounts on the document ...
    await store.ensureSession(DOCUMENT_PATH);
    // ... pane 2 mounts on the SAME document afterward.
    await store.ensureSession(DOCUMENT_PATH);

    assert.equal(
      documentCollaborationIpcDouble.invokeCallCount("get-collaboration-session"),
      1,
      "a second pane on an already-cached document must not read the sidecar again",
    );
    assert.deepEqual(pane1.value, initialSession);
    assert.deepEqual(pane2.value, initialSession);
    assert.deepEqual(panel.value.map((a) => a.annotationId), [created.annotationId]);

    // ONE mutation: an agent replies to the annotation's thread.
    await service.addAnnotationMessage({
      documentId: DOCUMENT_ID,
      annotationId: created.annotationId,
      actor: "agent",
      text: "Looked at this — proposing a tighter opening line.",
      clientRequestId: "agent-reply-1",
      expectedAnnotationGeneration: 1,
    });
    const nextSession = sessionFor(authority, service);
    documentCollaborationIpcDouble.emit("documents-update", {
      event: DP_EVENTS.DOCUMENT_COLLABORATION,
      context: { filePath: DOCUMENT_PATH, collaborationSession: nextSession },
    });

    // Both panes and the panel show the same set after the one broadcast —
    // and still without a second read of the sidecar.
    assert.equal(documentCollaborationIpcDouble.invokeCallCount("get-collaboration-session"), 1);
    assert.equal(pane1.value?.annotations.items[0].messages.length, 2);
    assert.deepEqual(pane1.value, nextSession);
    assert.deepEqual(pane2.value, pane1.value);
    assert.deepEqual(
      panel.value.map((a) => a.messages.length),
      [2],
    );
  });

  it("prunes a closed document's cached session and forgets nothing else", async function () {
    const { authority, service } = harness();
    await annotate(service);
    const session = sessionFor(authority, service);

    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(DOCUMENT_PATH);
    assert.ok(store.getSession(DOCUMENT_PATH) !== undefined);

    documentCollaborationIpcDouble.emit("documents-update", {
      event: DP_EVENTS.CLOSE_FILE,
      context: { filePath: DOCUMENT_PATH },
    });
    assert.equal(store.getSession(DOCUMENT_PATH), undefined);

    // Reopening the same document is a fresh read, not a stale replay of the
    // pruned entry.
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    await store.ensureSession(DOCUMENT_PATH);
    assert.deepEqual(store.getSession(DOCUMENT_PATH), session);
    assert.equal(documentCollaborationIpcDouble.invokeCallCount("get-collaboration-session"), 2);
  });
});
