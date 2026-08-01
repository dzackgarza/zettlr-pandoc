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

  it("keeps an identical later sibling's id after the earlier sibling is accepted", function () {
    const reference = ["same", "b", "c", "d", "e", "same"].join("\n");
    const working = ["different", "b", "c", "d", "e", "different"].join("\n");
    const before = computeReviewChunks(reference, working);
    assert.equal(before.length, 2);

    const acceptedFirst = spliceChunk(reference, before[0], "accept");
    const after = computeReviewChunks(acceptedFirst, working);

    assert.equal(after.length, 1);
    assert.equal(
      after[0].chunkId,
      before[1].chunkId,
      "identity may not be renumbered when an identical sibling leaves the partition",
    );
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

describe("computeReviewChunks block-aware boundaries", function () {
  it("splits an edit spanning two paragraphs into one decision per paragraph", function () {
    // The raw kernel glues this rewrite into ONE chunk (the paragraph seam
    // moves, so no unchanged line separates the two edits). The seam policy
    // splits it: two paragraph-level claims, two decisions.
    const reference = ["intro", "", "alpha one", "alpha two", "", "beta one", "", "tail"].join("\n");
    const working = ["intro", "", "alpha ONE", "", "beta one EXTENDED", "beta two", "", "tail"].join("\n");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].referenceText, "alpha one\nalpha two");
    assert.equal(chunks[0].workingText, "alpha ONE");
    assert.equal(chunks[1].referenceText, "\nbeta one");
    assert.equal(chunks[1].workingText, "\nbeta one EXTENDED\nbeta two");
  });

  it("merges two edits inside one $$ environment into one chunk at its edges", function () {
    const reference = [
      "before", "",
      "$$", "\\begin{aligned}", "a &= b \\\\", "mid one", "mid two", "c &= d", "\\end{aligned}", "$$",
      "", "after",
    ].join("\n");
    const working = reference.replace("a &= b", "a &= B").replace("c &= d", "c &= D");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 1, "one environment, one decision");
    // The chunk covers the whole environment, fences included: lines [3,11).
    assert.equal(chunks[0].refFromLine, 3);
    assert.equal(chunks[0].refToLine, 11);
    assert.equal(chunks[0].workFromLine, 3);
    assert.equal(chunks[0].workToLine, 11);
    assert.ok(chunks[0].referenceText.startsWith("$$"));
    assert.ok(chunks[0].referenceText.endsWith("$$"));
  });

  it("no longer splits mid-\\begin{aligned} when an environment is rewritten", function () {
    // The motivating defect: the raw character diff matches the shared
    // \begin{aligned} line and starts the chunk strictly inside the
    // environment (raw ranges: ref [5,7), work [5,8)).
    const reference = [
      "para", "", "$$", "\\begin{aligned}", "x &= 1 \\\\", "y &= 2", "\\end{aligned}", "$$", "", "tail",
    ].join("\n");
    const working = [
      "para", "", "$$", "\\begin{aligned}", "u &= 7 \\\\", "v &= 8 \\\\", "w &= 9", "\\end{aligned}", "$$", "", "tail",
    ].join("\n");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 1);
    assert.deepEqual(
      [chunks[0].refFromLine, chunks[0].refToLine, chunks[0].workFromLine, chunks[0].workToLine],
      [3, 9, 3, 10],
      "the chunk must cover the environment edge to edge on both sides",
    );
  });

  it("guards boundaries with a fence that exists only in the working text", function () {
    // The edit INSERTS the $$ environment: the reference has no fences at
    // all, yet no boundary may land inside the new environment. The raw
    // kernel puts one at the closing $$ (work line 5).
    const reference = ["p", "", "a + b", "more text", "", "q"].join("\n");
    const working = ["p", "", "$$", "a + b", "$$", "more text edited", "", "q"].join("\n");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].workFromLine, 3);
    assert.equal(chunks[0].workToLine, 7);
    assert.equal(chunks[0].workingText, "$$\na + b\n$$\nmore text edited");
  });

  it("keeps a ```` fence atomic when its body contains a shorter ``` run", function () {
    // A four-backtick fence is how a Markdown document quotes a three-backtick
    // block verbatim, so the inner ``` is CONTENT. Closing the block on it
    // leaves the second half of the code unguarded, and the seam policy then
    // hands out one Accept/Reject per half of a block that only compiles, runs,
    // and means anything as a whole. Per CommonMark a closing fence must be the
    // same character AND at least as long as the opener.
    const reference = [
      "para", "",
      "````", "print(one)", "```", "print(two)", "````",
      "", "tail",
    ].join("\n");
    const working = reference
      .replace("print(one)", "print(ONE)")
      .replace("print(two)", "print(TWO)");
    const chunks = computeReviewChunks(reference, working);
    assert.equal(chunks.length, 1, "one code block, one decision");
    assert.deepEqual(
      [chunks[0].refFromLine, chunks[0].refToLine],
      [3, 8],
      "the chunk must cover the outer fence edge to edge",
    );
    assert.equal(
      chunks[0].workingText,
      "````\nprint(ONE)\n```\nprint(TWO)\n````",
    );
  });

  it("converges under accept and reject with the policies active", function () {
    const reference = [
      "intro", "", "alpha one", "alpha two", "", "$$", "x &= 1", "$$", "", "tail",
    ].join("\n");
    const working = [
      "intro", "", "alpha ONE", "", "beta inserted", "", "$$", "x &= 1 \\\\", "y &= 2", "$$", "", "tail",
    ].join("\n");

    let currentReference = reference;
    for (let guard = 0; guard < 20; guard++) {
      const chunks = computeReviewChunks(currentReference, working);
      if (chunks.length === 0) {
        break;
      }
      currentReference = spliceChunk(currentReference, chunks[0], "accept");
    }
    assert.equal(currentReference, working, "accepting every chunk must converge");

    let currentWorking = working;
    for (let guard = 0; guard < 20; guard++) {
      const chunks = computeReviewChunks(reference, currentWorking);
      if (chunks.length === 0) {
        break;
      }
      currentWorking = spliceChunk(currentWorking, chunks[0], "reject");
    }
    assert.equal(currentWorking, reference, "rejecting every chunk must converge");
  });

  it("keeps block-shaped chunk ids stable while other chunks are decided", function () {
    const reference = [
      "intro", "", "alpha one", "alpha two", "", "$$", "x &= 1", "$$", "", "tail",
    ].join("\n");
    const working = [
      "intro", "", "alpha ONE", "", "$$", "x &= 1 \\\\", "y &= 2", "$$", "", "tail",
    ].join("\n");
    const before = computeReviewChunks(reference, working);
    assert.ok(before.length >= 2, `expected at least two chunks, got ${before.length}`);

    const newReference = spliceChunk(reference, before[0], "accept");
    const after = computeReviewChunks(newReference, working);
    assert.equal(after.length, before.length - 1);
    assert.deepEqual(
      after.map((chunk) => chunk.chunkId),
      before.slice(1).map((chunk) => chunk.chunkId),
      "deciding one chunk must not retire the ids of the others",
    );
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
