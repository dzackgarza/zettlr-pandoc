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
 *                  filesystem. The tests certify its asynchronous contract
 *                  and the one total parser for persisted version-2 data.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { ReviewSidecarData } from "source/app/service-providers/documents/review-diff-store";
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
    unresolvedChunks: 1,
    heldChunks: 1,
    savedAt: "2026-08-01T00:03:00.000Z",
  };
}

describe("ReviewSidecarStore", function () {
  let directory: string;
  let documentPath: string;
  let store: ReviewSidecarStore;

  beforeEach(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-review-sidecar-"));
    documentPath = path.join(directory, "document.md");
    store = new ReviewSidecarStore(path.join(directory, "sidecars"));
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

  it("rejects every malformed required field before persisted state reaches restore", async function () {
    const valid = sidecar(documentPath);
    const packet = valid.packets[0];
    const submission = valid.submissions[0];
    const hold = valid.holds[0];
    const comment = valid.comments[0];
    const invalidSidecars: unknown[] = [
      // A version-1 sidecar is the pre-flattening shape: it must fail loudly
      // rather than restore a review whose packets carry no attribution.
      { ...valid, version: 1 },
      { ...valid, version: 3 },
      { ...valid, reviewId: 1 },
      { ...valid, documentPath: false },
      { ...valid, referenceText: [] },
      { ...valid, workingText: {} },
      { ...valid, generation: "1" },
      { ...valid, diskFenceSha256: 1 },
      { ...valid, diskFenceSha256: "fence" },
      { ...valid, invalidated: "false" },
      { ...valid, packets: null },
      { ...valid, submissions: null },
      { ...valid, holds: null },
      { ...valid, comments: null },
      { ...valid, unresolvedChunks: "1" },
      { ...valid, heldChunks: "1" },
      { ...valid, savedAt: 1 },
      { ...valid, packets: [{ ...packet, packetId: 1 }] },
      { ...valid, packets: [{ ...packet, reviewId: 1 }] },
      { ...valid, packets: [{ ...packet, clientRequestId: 1 }] },
      { ...valid, packets: [{ ...packet, description: 1 }] },
      { ...valid, packets: [{ ...packet, appliedAt: 1 }] },
      { ...valid, packets: [{ ...packet, requestFingerprint: "not-a-hash" }] },
      { ...valid, packets: [{ ...packet, patch: 1 }] },
      { ...valid, packets: [{ ...packet, applicationGeneration: "1" }] },
      { ...valid, packets: [{ ...packet, refSpans: null }] },
      { ...valid, packets: [{ ...packet, refSpans: [{ from: "1", to: 2 }] }] },
      { ...valid, packets: [{ ...packet, refSpans: [{ from: 1, to: "2" }] }] },
      {
        ...valid,
        packets: [
          packet,
          { ...packet, refSpans: [{ from: 1, to: 2 }, { from: "1", to: 2 }] },
        ],
      },
      { ...valid, submissions: [{ ...submission, clientRequestId: 1 }] },
      { ...valid, submissions: [{ ...submission, requestFingerprint: "short" }] },
      { ...valid, submissions: [{ ...submission, packetIds: [1] }] },
      { ...valid, submissions: [{ ...submission, response: "ok" }] },
      { ...valid, holds: [{ ...hold, chunkId: 1 }] },
      { ...valid, holds: [{ ...hold, comment: 1 }] },
      { ...valid, holds: [{ ...hold, heldAt: 1 }] },
      { ...valid, holds: [hold, { ...hold, chunkId: 1 }] },
      { ...valid, comments: [{ ...comment, text: 1 }] },
      { ...valid, comments: [{ ...comment, createdAt: 1 }] },
      { ...valid, comments: [{ ...comment, orphanedFromChunkId: 1 }] },
      { ...valid, comments: [comment, { ...comment, text: 1 }] },
    ];

    const sidecarDirectory = path.dirname(
      reviewSidecarFilePath(path.join(directory, "sidecars"), documentPath),
    );
    mkdirSync(sidecarDirectory, { recursive: true });
    const persistedPath = reviewSidecarFilePath(sidecarDirectory, documentPath);
    for (const invalid of invalidSidecars) {
      writeFileSync(persistedPath, JSON.stringify(invalid), "utf8");
      await assert.rejects(Promise.resolve(store.read(documentPath)), Error);
    }
  });

  it("rejects a sidecar whose payload path does not match its hashed filename", async function () {
    const expected = sidecar(documentPath);
    await store.write(expected);
    const persistedPath = reviewSidecarFilePath(path.join(directory, "sidecars"), documentPath);
    writeFileSync(
      persistedPath,
      JSON.stringify({ ...expected, documentPath: path.join(directory, "other.md") }),
      "utf8",
    );
    await assert.rejects(store.read(documentPath), /does not match its document path/);
  });

  it("serializes overlapping writes to the same sidecar", async function () {
    const first = sidecar(documentPath);
    const second = { ...first, workingText: "SECOND\n" };
    await Promise.all([store.write(first), store.write(second)]);
    assert.equal((await store.read(documentPath))?.workingText, "SECOND\n");
  });
});
