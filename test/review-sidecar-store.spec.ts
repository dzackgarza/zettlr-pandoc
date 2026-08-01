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
 *                  and the one total parser for persisted version-1 data.
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

function sidecar(documentPath: string): ReviewSidecarData {
  return {
    version: 1,
    reviewId: "review-1",
    documentPath,
    baselineText: "alpha\n",
    referenceText: "alpha\n",
    workingText: "ALPHA\n",
    generation: 1,
    diskFenceSha256: "fence",
    invalidated: false,
    packets: [
      {
        packetId: "packet-1",
        reviewId: "review-1",
        clientRequestId: "request-1",
        description: "capitalize alpha",
        appliedAt: "2026-08-01T00:00:00.000Z",
        patchFormat: "unified-diff",
        patch: "--- document\n+++ document\n@@ -1 +1 @@\n-alpha\n+ALPHA\n",
        applicationGeneration: 1,
        refSpans: [{ from: 1, to: 2 }],
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
    const hold = valid.holds[0];
    const comment = valid.comments[0];
    const invalidSidecars: unknown[] = [
      { ...valid, version: 2 },
      { ...valid, reviewId: 1 },
      { ...valid, documentPath: false },
      { ...valid, baselineText: null },
      { ...valid, referenceText: [] },
      { ...valid, workingText: {} },
      { ...valid, generation: "1" },
      { ...valid, diskFenceSha256: 1 },
      { ...valid, invalidated: "false" },
      { ...valid, packets: null },
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
      { ...valid, packets: [{ ...packet, patchFormat: "other" }] },
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
});
