/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Review sidecar filesystem and validation boundary tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the production sidecar store against the real
 *                  filesystem. The schema is not restated here — the store's
 *                  own TypeBox declaration is the subject, and a copy of it
 *                  in the test would pass while the two drifted apart. The
 *                  cases below are the classes of defect that must not reach
 *                  restored review state, plus the durability the store
 *                  promises: a failed write leaves the previous sidecar
 *                  whole, and leaves nothing behind.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { ReviewSidecarData } from "source/app/service-providers/documents/review-sidecar-schema";
import {
  ReviewSidecarStore,
  reviewSidecarFilePath,
} from "source/app/service-providers/documents/review-sidecar-store";

const FINGERPRINT =
  "1111111111111111111111111111111111111111111111111111111111111111";

function sidecar(documentPath: string): ReviewSidecarData {
  return {
    version: 2,
    reviewId: "review-1",
    documentPath,
    referenceText: "alpha\n",
    workingText: "ALPHA\n",
    generation: 1,
    diskFenceSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
        refSpans: [{ from: 1, to: 2 }],
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
          state: "active",
        },
      },
    ],
    holds: [
      {
        chunkId: "chunk-1",
        comment: "check this",
        heldAt: "2026-08-01T00:01:00.000Z",
      },
    ],
    comments: [
      {
        text: "overall note",
        createdAt: "2026-08-01T00:02:00.000Z",
        orphanedFromChunkId: "chunk-old",
      },
    ],
  };
}

describe("ReviewSidecarStore", function () {
  let directory: string;
  let sidecarDirectory: string;
  let documentPath: string;
  let store: ReviewSidecarStore;

  /** Overwrite the persisted bytes without going through the store. */
  function persistRaw(payload: unknown): void {
    mkdirSync(sidecarDirectory, { recursive: true });
    writeFileSync(
      reviewSidecarFilePath(sidecarDirectory, documentPath),
      JSON.stringify(payload),
      "utf8",
    );
  }

  beforeEach(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-review-sidecar-"));
    sidecarDirectory = path.join(directory, "sidecars");
    documentPath = path.join(directory, "document.md");
    store = new ReviewSidecarStore(sidecarDirectory);
  });

  afterEach(function () {
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

  it("restores a valid version-2 sidecar, pendingSave included", async function () {
    const withPendingSave: ReviewSidecarData = {
      ...sidecar(documentPath),
      pendingSave: { beforeDiskSha256: FINGERPRINT, afterDiskSha256: FINGERPRINT },
    };
    await store.write(withPendingSave);
    assert.deepEqual(await store.read(documentPath), withPendingSave);
  });

  it("rejects a packet missing a required nested field", async function () {
    const valid = sidecar(documentPath);
    const withoutSpans: Record<string, unknown> = { ...valid.packets[0] };
    delete withoutSpans.refSpans;
    persistRaw({ ...valid, packets: [withoutSpans] });
    await assert.rejects(store.read(documentPath), /refSpans/);
  });

  it("rejects a field the schema does not declare", async function () {
    persistRaw({ ...sidecar(documentPath), savedAt: "2026-08-01T00:03:00.000Z" });
    await assert.rejects(store.read(documentPath), /not a version-2 review sidecar/);
  });

  it("rejects a hash that is not a sha256", async function () {
    persistRaw({ ...sidecar(documentPath), diskFenceSha256: "fence" });
    await assert.rejects(store.read(documentPath), /diskFenceSha256/);
  });

  it("rejects a version-1 sidecar rather than migrating it", async function () {
    persistRaw({ ...sidecar(documentPath), version: 1 });
    await assert.rejects(store.read(documentPath), /not a version-2 review sidecar/);
  });

  it("rejects a sidecar whose payload path does not match its hashed filename", async function () {
    persistRaw({ ...sidecar(documentPath), documentPath: path.join(directory, "other.md") });
    await assert.rejects(store.read(documentPath), /does not match its document path/);
  });

  it("leaves the previous complete sidecar behind when a write fails", async function () {
    const first = sidecar(documentPath);
    await store.write(first);

    // A payload JSON.stringify cannot serialize: the write throws before any
    // byte of the target file is replaced.
    const unserializable: ReviewSidecarData & { self?: unknown } = { ...first };
    unserializable.self = unserializable;
    await assert.rejects(store.write(unserializable), TypeError);

    assert.deepEqual(await store.read(documentPath), first);
    assert.deepEqual(
      readdirSync(sidecarDirectory),
      [path.basename(reviewSidecarFilePath(sidecarDirectory, documentPath))],
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
        readFileSync(reviewSidecarFilePath(sidecarDirectory, documentPath), "utf8"),
      ),
      persisted,
    );
    assert.equal(readdirSync(sidecarDirectory).length, 1);
  });
});
