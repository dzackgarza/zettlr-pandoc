/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Collaboration sidecar filesystem and validation boundary tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the production sidecar store against the real
 *                  filesystem. The schema is not restated here — the store's
 *                  own TypeBox declaration is the subject, and a copy of it
 *                  in the test would pass while the two drifted apart. The
 *                  cases below are the classes of defect that must not reach
 *                  restored collaboration state, the deterministic version-4
 *                  lift, the survival rule that ties a sidecar's existence to
 *                  its content, and the durability the store promises: a
 *                  failed write leaves the previous sidecar whole, and
 *                  leaves nothing behind.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import type { TextAnnotation } from "source/types/common/annotation-domain";
import type { CollaborationSidecarData } from "source/app/service-providers/documents/collaboration-sidecar-schema";
import {
  CollaborationSidecarStore,
  collaborationSidecarFilePath,
} from "source/app/service-providers/documents/collaboration-sidecar-store";

const FINGERPRINT =
  "1111111111111111111111111111111111111111111111111111111111111111";

/** The version-5 `review` block: everything version 4 kept flat, now nested. */
function persistedReview(): CollaborationSidecarData["review"] & object {
  return {
    reviewId: "review-1",
    generation: 1,
    invalidated: false,
    packets: [
      {
        packetId: "packet-1",
        reviewId: "review-1",
        clientRequestId: "request-1",
        requestFingerprint: FINGERPRINT,
        description: "capitalize alpha",
        appliedAt: "2026-08-01T00:00:00.000Z",
        patch: "--- document\n+++ document\n@@ -1 +1 @@\n-alpha\n+ALPHA\n",
        applicationGeneration: 1,
      },
    ],
    suggestions: [
      {
        suggestionId: "suggestion-1",
        packetId: "packet-1",
        kind: "substitution" as const,
        removedText: "alpha",
        restorations: [{ at: 0, text: "alpha" }],
        anchors: [{ from: 0, to: 5 }],
        seam: 0,
        state: "proposed" as const,
      },
    ],
    submissions: [
      {
        clientRequestId: "request-1",
        requestFingerprint: FINGERPRINT,
        packetIds: ["packet-1"],
        response: {
          packetId: "packet-1",
          packetIds: ["packet-1"],
          reviewId: "review-1",
          documentId: "doc-1",
          documentRevision: { sha256: FINGERPRINT },
          reviewGeneration: 1,
          unresolvedChunks: 1,
          state: "active" as const,
        },
      },
    ],
    chunkComments: [
      {
        chunkId: "suggestion-1",
        comment: "check this",
        commentedAt: "2026-08-01T00:01:00.000Z",
      },
    ],
    comments: [
      {
        text: "overall note",
        createdAt: "2026-08-01T00:02:00.000Z",
      },
    ],
  };
}

function sidecar(documentPath: string): CollaborationSidecarData {
  return {
    version: 5,
    documentPath,
    workingText: "ALPHA\n",
    diskFenceSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    review: persistedReview(),
    annotations: { generation: 0, items: [] },
  };
}

/** The version-4 fixture on disk that this suite's migration cases lift. */
function legacySidecarBytes(documentPath: string): Record<string, unknown> {
  const review = persistedReview();
  return {
    version: 4,
    reviewId: review.reviewId,
    documentPath,
    workingText: "ALPHA\n",
    generation: review.generation,
    diskFenceSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    invalidated: review.invalidated,
    packets: review.packets,
    suggestions: review.suggestions,
    submissions: review.submissions,
    chunkComments: review.chunkComments,
    comments: review.comments,
  };
}

function annotation(annotationId: string): TextAnnotation {
  return {
    annotationId,
    documentId: "doc-1",
    anchor: { state: "range", from: 0, to: 5, quotedText: "ALPHA" },
    state: "open",
    messages: [
      { messageId: "message-1", author: "owner", text: "check this capitalization", createdAt: "2026-08-01T00:00:00.000Z" },
      { messageId: "message-2", author: "agent", clientRequestId: "request-a1", text: "capitalization is intentional here", createdAt: "2026-08-01T00:03:00.000Z" },
    ],
    proposalActions: [
      { actionId: "action-1", packetId: "packet-1", reviewId: "review-1", linkedAt: "2026-08-01T00:04:00.000Z", terminalOutcome: "accepted" },
    ],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:03:00.000Z",
  };
}

describe("CollaborationSidecarStore", function () {
  let directory: string;
  let sidecarDirectory: string;
  let documentPath: string;
  let store: CollaborationSidecarStore;

  /** Overwrite the persisted bytes without going through the store. */
  function persistRaw(payload: unknown): void {
    mkdirSync(sidecarDirectory, { recursive: true });
    writeFileSync(
      collaborationSidecarFilePath(sidecarDirectory, documentPath),
      JSON.stringify(payload),
      "utf8",
    );
  }

  beforeEach(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-collaboration-sidecar-"));
    sidecarDirectory = path.join(directory, "sidecars");
    documentPath = path.join(directory, "document.md");
    store = new CollaborationSidecarStore(sidecarDirectory);
  });

  afterEach(function () {
    // A permission injection that failed mid-test would otherwise leave a
    // directory this cannot remove.
    if (existsSync(sidecarDirectory)) {
      chmodSync(sidecarDirectory, 0o700);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("composes real filesystem writes and reads as asynchronous operations", async function () {
    const expected = sidecar(documentPath);
    const writing = store.write(expected);
    const firstSettled = await Promise.race([
      Promise.resolve(writing).then(() => "filesystem"),
      Promise.resolve("event-loop"),
    ]);
    assert.equal(
      firstSettled,
      "event-loop",
      "the filesystem operation must yield instead of completing in the initiating turn",
    );
    await writing;
    assert.deepEqual(await store.read(documentPath), expected);
  });

  it("restores a valid sidecar, pendingSave included", async function () {
    const withPendingSave: CollaborationSidecarData = {
      ...sidecar(documentPath),
      pendingSave: { beforeDiskSha256: FINGERPRINT, afterDiskSha256: FINGERPRINT },
    };
    await store.write(withPendingSave);
    assert.deepEqual(await store.read(documentPath), withPendingSave);
  });

  it("reads a version-4 fixture as version 5, writes it back, and is identical after a restart", async function () {
    persistRaw(legacySidecarBytes(documentPath));

    const expected: CollaborationSidecarData = {
      ...sidecar(documentPath),
      annotations: { generation: 0, items: [] },
    };
    const migrated = await store.read(documentPath);
    assert.deepEqual(migrated, expected);

    // The bytes on disk must themselves be version 5 — not merely the value
    // this call happened to return.
    const onDisk: unknown = JSON.parse(
      readFileSync(collaborationSidecarFilePath(sidecarDirectory, documentPath), "utf8"),
    );
    assert.deepEqual(onDisk, expected);

    // A second read is the app-restart case: nothing left to migrate, and
    // the same content comes back.
    assert.deepEqual(await store.read(documentPath), expected);
  });

  it("rejects a version-3 sidecar rather than migrating it", async function () {
    persistRaw({ ...legacySidecarBytes(documentPath), version: 3 });
    await assert.rejects(store.read(documentPath), /not a valid collaboration sidecar/);
  });

  it("rejects a field the schema does not declare", async function () {
    persistRaw({ ...sidecar(documentPath), savedAt: "2026-08-01T00:03:00.000Z" });
    await assert.rejects(store.read(documentPath), /not a valid collaboration sidecar/);
  });

  it("rejects a packet field retired from the suggestion model", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    const legacyPacket = { ...review.packets[0], refSpans: [{ from: 1, to: 2 }] };
    persistRaw({ ...valid, review: { ...review, packets: [legacyPacket] } });
    await assert.rejects(store.read(documentPath), /not a valid collaboration sidecar/);
  });

  it("rejects a hash that is not a sha256", async function () {
    persistRaw({ ...sidecar(documentPath), diskFenceSha256: "fence" });
    await assert.rejects(store.read(documentPath), /diskFenceSha256/);
  });

  it("rejects duplicate suggestion identities", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    persistRaw({ ...valid, review: { ...review, suggestions: [review.suggestions[0], review.suggestions[0]] } });
    await assert.rejects(store.read(documentPath), /duplicate suggestion id suggestion-1/);
  });

  it("rejects a suggestion without an owning packet", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    persistRaw({
      ...valid,
      review: { ...review, suggestions: [{ ...review.suggestions[0], packetId: "missing-packet" }] },
    });
    await assert.rejects(store.read(documentPath), /has no owning packet/);
  });

  it("rejects unsorted, overlapping, and out-of-bounds anchors", async function () {
    const invalidAnchors = [
      [{ from: 3, to: 5 }, { from: 1, to: 2 }],
      [{ from: 0, to: 4 }, { from: 3, to: 5 }],
      [{ from: 0, to: 7 }],
      [{ from: -1, to: 1 }],
    ];
    for (const anchors of invalidAnchors) {
      const valid = sidecar(documentPath);
      const review = valid.review!;
      persistRaw({
        ...valid,
        review: { ...review, suggestions: [{ ...review.suggestions[0], anchors }] },
      });
      await assert.rejects(store.read(documentPath), /has invalid anchors|must be >= 0/);
    }
  });

  it("rejects out-of-bounds seams and restorations", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;

    persistRaw({
      ...valid,
      review: { ...review, suggestions: [{ ...review.suggestions[0], seam: valid.workingText.length + 1 }] },
    });
    await assert.rejects(store.read(documentPath), /has an invalid seam|must be >= 0/);

    persistRaw({
      ...valid,
      review: { ...review, suggestions: [{ ...review.suggestions[0], seam: -1 }] },
    });
    await assert.rejects(store.read(documentPath), /has an invalid seam|must be >= 0/);

    persistRaw({
      ...valid,
      review: {
        ...review,
        suggestions: [{
          ...review.suggestions[0],
          restorations: [{ at: valid.workingText.length + 1, text: "alpha" }],
        }],
      },
    });
    await assert.rejects(
      store.read(documentPath),
      /has an invalid restoration|must be >= 0/,
    );

    persistRaw({
      ...valid,
      review: {
        ...review,
        suggestions: [{ ...review.suggestions[0], restorations: [{ at: -1, text: "alpha" }] }],
      },
    });
    await assert.rejects(
      store.read(documentPath),
      /has an invalid restoration|must be >= 0/,
    );
  });

  it("rejects incoherent insertion, deletion, and substitution data", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    const incoherent = [
      { ...review.suggestions[0], kind: "insertion", removedText: "alpha" },
      { ...review.suggestions[0], kind: "deletion", anchors: [{ from: 0, to: 5 }] },
      { ...review.suggestions[0], kind: "substitution", restorations: [] },
    ];
    for (const suggestion of incoherent) {
      persistRaw({ ...valid, review: { ...review, suggestions: [suggestion] } });
      await assert.rejects(store.read(documentPath), /has incoherent change data/);
    }
  });

  it("accepts a deletion represented by one zero-length anchor", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    const deletion: CollaborationSidecarData = {
      ...valid,
      review: {
        ...review,
        suggestions: [{ ...review.suggestions[0], kind: "deletion", anchors: [{ from: 0, to: 0 }] }],
      },
    };
    await store.write(deletion);
    assert.deepEqual(await store.read(documentPath), deletion);
  });

  it("accepts one deletion with multiple zero-length anchors", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    const deletion: CollaborationSidecarData = {
      ...valid,
      review: {
        ...review,
        suggestions: [{
          ...review.suggestions[0],
          kind: "deletion",
          restorations: [{ at: 0, text: "al" }, { at: 2, text: "pha" }],
          anchors: [{ from: 0, to: 0 }, { from: 2, to: 2 }],
        }],
      },
    };
    await store.write(deletion);
    assert.deepEqual(await store.read(documentPath), deletion);
  });

  it("rejects overlapping proposed suggestion anchors", async function () {
    const valid = sidecar(documentPath);
    const review = valid.review!;
    persistRaw({
      ...valid,
      review: {
        ...review,
        suggestions: [review.suggestions[0], { ...review.suggestions[0], suggestionId: "suggestion-2" }],
      },
    });
    await assert.rejects(store.read(documentPath), /suggestions suggestion-1 and suggestion-2 overlap/);
  });

  it("rejects a sidecar whose payload path does not match its hashed filename", async function () {
    persistRaw({ ...sidecar(documentPath), documentPath: path.join(directory, "other.md") });
    await assert.rejects(store.read(documentPath), /does not match its document path/);
  });

  it("round-trips a text annotation exactly, including its message thread", async function () {
    const withAnnotation: CollaborationSidecarData = {
      ...sidecar(documentPath),
      review: null,
      annotations: { generation: 1, items: [annotation("annotation-1")] },
    };
    await store.write(withAnnotation);
    assert.deepEqual(await store.read(documentPath), withAnnotation);
  });

  it("rejects a duplicate annotation id", async function () {
    persistRaw({
      ...sidecar(documentPath),
      review: null,
      annotations: { generation: 1, items: [annotation("annotation-1"), annotation("annotation-1")] },
    });
    await assert.rejects(store.read(documentPath), /duplicate annotation id annotation-1/);
  });

  it("rejects an annotation with no messages", async function () {
    const empty = { ...annotation("annotation-1"), messages: [] };
    persistRaw({
      ...sidecar(documentPath),
      review: null,
      annotations: { generation: 1, items: [empty] },
    });
    await assert.rejects(store.read(documentPath), /not a valid collaboration sidecar/);
  });

  it("keeps a sidecar alive on annotations alone, and removes it once both clear", async function () {
    const annotationOnly: CollaborationSidecarData = {
      ...sidecar(documentPath),
      review: null,
      annotations: { generation: 1, items: [annotation("annotation-1")] },
    };
    await store.write(annotationOnly);
    assert.deepEqual(await store.read(documentPath), annotationOnly);

    await store.write({ ...annotationOnly, annotations: { generation: 1, items: [] } });
    assert.equal(await store.read(documentPath), undefined);
    assert.deepEqual(
      readdirSync(sidecarDirectory).filter((name) => name.endsWith(".json")),
      [],
      "a sidecar with no review and no annotations must not remain on disk",
    );
  });

  it("never writes annotation or review state into the document's own file", async function () {
    const original = "alpha\n";
    writeFileSync(documentPath, original, "utf8");

    await store.write(sidecar(documentPath));
    await store.write({
      ...sidecar(documentPath),
      annotations: { generation: 1, items: [annotation("annotation-1")] },
    });

    assert.equal(readFileSync(documentPath, "utf8"), original);
  });

  it("leaves the previous complete sidecar behind when a write fails", async function () {
    if (process.getuid?.() === 0) {
      this.skip(); // root ignores the directory permission this injection needs
    }
    const first = sidecar(documentPath);
    await store.write(first);

    // The failure has to happen INSIDE the write, not before it: an
    // unserializable payload throws in JSON.stringify and would leave the
    // previous file whole even for a store that truncated its target in
    // place. An unwritable directory instead refuses the staged temporary
    // file — which is exactly what a store writing straight to the target
    // would never need, and so would not fail on at all.
    chmodSync(sidecarDirectory, 0o500);
    const second: CollaborationSidecarData = {
      ...first,
      workingText: "SECOND\n",
      review: { ...first.review!, generation: 2 },
    };
    await assert.rejects(
      store.write(second),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EACCES",
      "the refused write must surface the filesystem's own structured error",
    );
    chmodSync(sidecarDirectory, 0o700);

    assert.deepEqual(await store.read(documentPath), first);
    assert.deepEqual(
      readdirSync(sidecarDirectory),
      [path.basename(collaborationSidecarFilePath(sidecarDirectory, documentPath))],
      "a failed write must leave no temporary file behind",
    );
  });

  it("ends concurrent writes with one complete valid payload", async function () {
    const first = sidecar(documentPath);
    const candidates = ["FIRST\n", "SECOND\n", "THIRD\n"].map((workingText) => ({
      ...first,
      workingText,
    }));
    await Promise.all(candidates.map(async (candidate) => await store.write(candidate)));

    const persisted = await store.read(documentPath);
    assert.ok(persisted !== undefined);
    assert.ok(
      candidates.some((candidate) => candidate.workingText === persisted.workingText),
      "the surviving payload must be one of the writes, not a splice of several",
    );
    // Read the bytes directly: a torn write parses as one payload only by
    // accident, and store.read would report that accident as success.
    assert.deepEqual(
      JSON.parse(
        readFileSync(collaborationSidecarFilePath(sidecarDirectory, documentPath), "utf8"),
      ),
      persisted,
    );
    assert.equal(readdirSync(sidecarDirectory).length, 1);
  });
});
