/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Review chunk engine tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Certifies the single shared chunk engine: the partition,
 *                  the content-addressed ids, and the splice that implements
 *                  accept/reject. Every property asserted here is one the old
 *                  two-engine architecture violated on real documents.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import {
  computeReviewChunks,
  spliceChunk,
} from "../source/common/modules/review/review-chunks";

describe("computeReviewChunks", function () {
  it("returns no chunks for identical texts", function () {
    assert.deepEqual(computeReviewChunks("a\nb\nc", "a\nb\nc"), []);
  });

  it("reports one chunk for one edited line among repeated identical lines", function () {
    // The phantom-split reproducer. jsdiff's diffLines pairs the edit's
    // insertion with a DIFFERENT copy of the repeated line, yielding two
    // non-adjacent changed parts — the old store counted 2 chunks here while
    // the renderer drew 1 widget, and the save gate could close over the
    // difference. Repeated lines are every Markdown document: blank lines,
    // `:::` fences, `$$` fences.
    const reference = "xxxxx\nxxxxx\nxxxxx\nline3\nend";
    const working = "xxxxx!\nxxxxx\nxxxxx\nline3\nend";
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].referenceText, "xxxxx");
    assert.equal(chunks[0].workingText, "xxxxx!");
    assert.equal(chunks[0].refFromLine, 1);
    assert.equal(chunks[0].refToLine, 2);
  });

  it("produces non-overlapping half-open ranges in document order", function () {
    const reference = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const working = ["a", "B", "c", "d", "e", "F", "g", "h", "I"].join("\n");
    const chunks = computeReviewChunks(reference, working);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(
        chunks[i].refFromLine >= chunks[i - 1].refToLine,
        "reference ranges must not overlap",
      );
      assert.ok(
        chunks[i].workFromLine >= chunks[i - 1].workToLine,
        "working ranges must not overlap",
      );
    }
  });

  it("keeps a chunk's id stable while other chunks are decided", function () {
    const reference = ["alpha", "b", "c", "d", "e", "f", "g", "omega"].join("\n");
    const working = ["ALPHA", "b", "c", "d", "e", "f", "g", "OMEGA"].join("\n");
    const before = computeReviewChunks(reference, working);
    assert.equal(before.length, 2);

    // Accept the first chunk: the reference now agrees with the working text
    // there, and the second chunk must keep its identity.
    const newReference = spliceChunk(reference, before[0], "accept");
    const after = computeReviewChunks(newReference, working);
    assert.equal(after.length, 1);
    assert.equal(after[0].chunkId, before[1].chunkId);
  });

  it("distinguishes identical edits at different positions by occurrence", function () {
    const reference = ["same", "b", "c", "d", "e", "same"].join("\n");
    const working = ["different", "b", "c", "d", "e", "different"].join("\n");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 2);
    assert.notEqual(chunks[0].chunkId, chunks[1].chunkId);
    assert.equal(chunks[1].chunkId, `${chunks[0].chunkId}-1`);
  });

  it("represents a pure insertion with an empty reference range", function () {
    const chunks = computeReviewChunks("a\nc", "a\nb\nc");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].refFromLine, chunks[0].refToLine);
    assert.equal(chunks[0].referenceText, "");
    assert.equal(chunks[0].workingText, "b");
  });

  it("represents a pure deletion with an empty working range", function () {
    const chunks = computeReviewChunks("a\nb\nc", "a\nc");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].workFromLine, chunks[0].workToLine);
    assert.equal(chunks[0].workingText, "");
    assert.equal(chunks[0].referenceText, "b");
  });
});

describe("spliceChunk", function () {
  it("accepting every chunk converges the reference onto the working text", function () {
    const reference = [
      "# Title",
      "",
      "One has the genus-degree formula:",
      "",
      "$$",
      "p_a(C) = 10",
      "$$",
      "",
      "unchanged tail",
    ].join("\n");
    const working = [
      "# Title",
      "",
      "Let $\\nu$ be the normalization.",
      "For an irreducible plane curve,",
      "",
      "$$",
      "g = p_a(C) - \\delta",
      "$$",
      "",
      "unchanged tail",
    ].join("\n");

    let currentReference = reference;
    for (let guard = 0; guard < 20; guard++) {
      const chunks = computeReviewChunks(currentReference, working);
      if (chunks.length === 0) {
        break;
      }
      currentReference = spliceChunk(currentReference, chunks[0], "accept");
    }
    assert.equal(currentReference, working);
  });

  it("rejecting every chunk converges the working text onto the reference", function () {
    const reference = ["a", "b", "c", "d", "e"].join("\n");
    const working = ["a", "B", "c", "D", "e", "f"].join("\n");

    let currentWorking = working;
    for (let guard = 0; guard < 20; guard++) {
      const chunks = computeReviewChunks(reference, currentWorking);
      if (chunks.length === 0) {
        break;
      }
      currentWorking = spliceChunk(currentWorking, chunks[0], "reject");
    }
    assert.equal(currentWorking, reference);
  });

  it("handles an appended line at the end of the document", function () {
    const chunks = computeReviewChunks("a", "a\nb");
    assert.equal(chunks.length, 1);
    assert.equal(spliceChunk("a", chunks[0], "accept"), "a\nb");
    assert.equal(spliceChunk("a\nb", chunks[0], "reject"), "a");
  });

  it("handles a deleted line at the end of the document", function () {
    const chunks = computeReviewChunks("a\nb", "a");
    assert.equal(chunks.length, 1);
    assert.equal(spliceChunk("a\nb", chunks[0], "accept"), "a");
    assert.equal(spliceChunk("a", chunks[0], "reject"), "a\nb");
  });

  it("accepts a middle chunk without disturbing its neighbours", function () {
    const reference = ["one", "x", "three", "y", "five"].join("\n");
    const working = ["ONE", "x", "THREE", "y", "FIVE"].join("\n");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 3);
    const middleAccepted = spliceChunk(reference, chunks[1], "accept");
    assert.equal(middleAccepted, ["one", "x", "THREE", "y", "five"].join("\n"));
  });
});
