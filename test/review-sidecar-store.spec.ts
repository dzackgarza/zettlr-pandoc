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
import type { ReviewSidecarData } from "source/app/service-providers/documents/review-sidecar-schema";
import {
  ReviewSidecarStore,
  reviewSidecarFilePath,
} from "source/app/service-providers/documents/review-sidecar-store";

const FINGERPRINT = "1111111111111111111111111111111111111111111111111111111111111111";

function sidecar(documentPath: string): ReviewSidecarData {
  return {
    version: 4,
    reviewId: "review-1",
    documentPath,
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
      },
    ],
    suggestions: [
      {
        suggestionId: "suggestion-1",
        packetId: "packet-1",
        kind: "substitution",
        removedText: "alpha",
        restorations: [{ at: 0, text: "alpha" }],
        anchors: [{ from: 0, to: 5 }],
        seam: 0,
        state: "proposed",
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
    const withPendingSave: ReviewSidecarData = {
      ...sidecar(documentPath),
      pendingSave: { beforeDiskSha256: FINGERPRINT, afterDiskSha256: FINGERPRINT },
    };
    await store.write(withPendingSave);
    assert.deepEqual(await store.read(documentPath), withPendingSave);
  });

  it("rejects a packet field retired from the suggestion model", async function () {
    const valid = sidecar(documentPath);
    const legacyPacket = { ...valid.packets[0], refSpans: [{ from: 1, to: 2 }] };
    persistRaw({ ...valid, packets: [legacyPacket] });
    await assert.rejects(store.read(documentPath), /not a valid review sidecar/);
  });

  it("rejects a field the schema does not declare", async function () {
    persistRaw({ ...sidecar(documentPath), savedAt: "2026-08-01T00:03:00.000Z" });
    await assert.rejects(store.read(documentPath), /not a valid review sidecar/);
  });

  it("rejects a hash that is not a sha256", async function () {
    persistRaw({ ...sidecar(documentPath), diskFenceSha256: "fence" });
    await assert.rejects(store.read(documentPath), /diskFenceSha256/);
  });

  it("rejects a version-3 sidecar rather than migrating it", async function () {
    persistRaw({ ...sidecar(documentPath), version: 3 });
    await assert.rejects(store.read(documentPath), /not a valid review sidecar/);
  });

  it("rejects duplicate suggestion identities", async function () {
    const valid = sidecar(documentPath);
    persistRaw({ ...valid, suggestions: [valid.suggestions[0], valid.suggestions[0]] });
    await assert.rejects(store.read(documentPath), /duplicate suggestion id suggestion-1/);
  });

  it("rejects a suggestion without an owning packet", async function () {
    const valid = sidecar(documentPath);
    persistRaw({
      ...valid,
      suggestions: [{ ...valid.suggestions[0], packetId: "missing-packet" }],
    });
    await assert.rejects(store.read(documentPath), /has no owning packet/);
  });

  it("rejects unsorted, overlapping, and out-of-bounds anchors", async function () {
    const invalidAnchors = [
      [
        { from: 3, to: 5 },
        { from: 1, to: 2 },
      ],
      [
        { from: 0, to: 4 },
        { from: 3, to: 5 },
      ],
      [{ from: 0, to: 7 }],
      [{ from: -1, to: 1 }],
    ];
    for (const anchors of invalidAnchors) {
      const valid = sidecar(documentPath);
      persistRaw({
        ...valid,
        suggestions: [{ ...valid.suggestions[0], anchors }],
      });
      await assert.rejects(store.read(documentPath), /has invalid anchors|must be >= 0/);
    }
  });

  it("rejects out-of-bounds seams and restorations", async function () {
    const valid = sidecar(documentPath);
    persistRaw({
      ...valid,
      suggestions: [{ ...valid.suggestions[0], seam: valid.workingText.length + 1 }],
    });
    await assert.rejects(store.read(documentPath), /has an invalid seam|must be >= 0/);

    persistRaw({
      ...valid,
      suggestions: [{ ...valid.suggestions[0], seam: -1 }],
    });
    await assert.rejects(store.read(documentPath), /has an invalid seam|must be >= 0/);

    persistRaw({
      ...valid,
      suggestions: [
        {
          ...valid.suggestions[0],
          restorations: [{ at: valid.workingText.length + 1, text: "alpha" }],
        },
      ],
    });
    await assert.rejects(store.read(documentPath), /has an invalid restoration|must be >= 0/);

    persistRaw({
      ...valid,
      suggestions: [
        {
          ...valid.suggestions[0],
          restorations: [{ at: -1, text: "alpha" }],
        },
      ],
    });
    await assert.rejects(store.read(documentPath), /has an invalid restoration|must be >= 0/);
  });

  it("rejects incoherent insertion, deletion, and substitution data", async function () {
    const valid = sidecar(documentPath);
    const incoherent = [
      { ...valid.suggestions[0], kind: "insertion", removedText: "alpha" },
      { ...valid.suggestions[0], kind: "deletion", anchors: [{ from: 0, to: 5 }] },
      { ...valid.suggestions[0], kind: "substitution", restorations: [] },
    ];
    for (const suggestion of incoherent) {
      persistRaw({ ...valid, suggestions: [suggestion] });
      await assert.rejects(store.read(documentPath), /has incoherent change data/);
    }
  });

  it("accepts a deletion represented by one zero-length anchor", async function () {
    const valid = sidecar(documentPath);
    const deletion: ReviewSidecarData = {
      ...valid,
      suggestions: [
        {
          ...valid.suggestions[0],
          kind: "deletion",
          anchors: [{ from: 0, to: 0 }],
        },
      ],
    };
    await store.write(deletion);
    assert.deepEqual(await store.read(documentPath), deletion);
  });

  it("accepts one deletion with multiple zero-length anchors", async function () {
    const valid = sidecar(documentPath);
    const deletion: ReviewSidecarData = {
      ...valid,
      suggestions: [
        {
          ...valid.suggestions[0],
          kind: "deletion",
          restorations: [
            { at: 0, text: "al" },
            { at: 2, text: "pha" },
          ],
          anchors: [
            { from: 0, to: 0 },
            { from: 2, to: 2 },
          ],
        },
      ],
    };
    await store.write(deletion);
    assert.deepEqual(await store.read(documentPath), deletion);
  });

  it("rejects overlapping proposed suggestion anchors", async function () {
    const valid = sidecar(documentPath);
    persistRaw({
      ...valid,
      suggestions: [
        valid.suggestions[0],
        { ...valid.suggestions[0], suggestionId: "suggestion-2" },
      ],
    });
    await assert.rejects(
      store.read(documentPath),
      /suggestions suggestion-1 and suggestion-2 overlap/,
    );
  });

  it("rejects a sidecar whose payload path does not match its hashed filename", async function () {
    persistRaw({ ...sidecar(documentPath), documentPath: path.join(directory, "other.md") });
    await assert.rejects(store.read(documentPath), /does not match its document path/);
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
    const second: ReviewSidecarData = { ...first, workingText: "SECOND\n", generation: 2 };
    await assert.rejects(
      store.write(second),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EACCES",
      "the refused write must surface the filesystem's own structured error",
    );
    chmodSync(sidecarDirectory, 0o700);

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
      JSON.parse(readFileSync(reviewSidecarFilePath(sidecarDirectory, documentPath), "utf8")),
      persisted,
    );
    assert.equal(readdirSync(sidecarDirectory).length, 1);
  });
});
