import { strict as assert } from "node:assert";
import type { TikzSourceBlock } from "source/common/modules/markdown-editor/tikz-block";
import {
  quiverReplacement,
  quiverSessionForBlock,
  quiverSourceForSession,
  sourceForQuiverExport,
} from "source/common/modules/markdown-editor/tikz-quiver";
import { contiguousSourceLineRanges } from "source/common/util/tikz-source-blocks";

function rawBlock(source: string): TikzSourceBlock {
  return {
    from: 10,
    to: 10 + source.length,
    sourceFrom: 10,
    sourceTo: 10 + source.length,
    source,
    sourceLineRanges: contiguousSourceLineRanges(source, 10),
    kind: "raw",
    language: "tikzcd",
  };
}

function fencedBlock(body: string): TikzSourceBlock {
  return {
    from: 20,
    to: 20 + body.length + 14,
    sourceFrom: 30,
    sourceTo: 30 + body.length,
    source: body,
    sourceLineRanges: contiguousSourceLineRanges(body, 30),
    kind: "fence",
    language: "tikzcd",
  };
}

describe("TikZ-cd ↔ Quiver source bridge", function () {
  it("hands raw tikzcd to Quiver byte-for-byte", function () {
    const source = "\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}";
    assert.strictEqual(quiverSourceForSession(quiverSessionForBlock(rawBlock(source))), source);
  });

  it("wraps only the body of a fenced tikzcd for Quiver parsing", function () {
    const session = quiverSessionForBlock(fencedBlock("A \\arrow[r] & B"));
    assert.strictEqual(
      quiverSourceForSession(session),
      "\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}",
    );
  });

  it("maps a canonical fenced export back to its body and advances every owned range by the same delta", function () {
    const session = quiverSessionForBlock(fencedBlock("A & B"));
    const replacement = quiverReplacement(
      session,
      '\\begin{tikzcd}\nA \\arrow[r, "f"] & B\n\\end{tikzcd}',
    );
    assert.deepStrictEqual(
      { from: replacement.from, to: replacement.to, insert: replacement.insert },
      { from: session.sourceFrom, to: session.sourceTo, insert: 'A \\arrow[r, "f"] & B' },
    );
    const delta = replacement.insert.length - session.source.length;
    assert.strictEqual(replacement.next.sourceTo, session.sourceTo + delta);
    assert.strictEqual(replacement.next.blockTo, session.blockTo + delta);
    assert.strictEqual(replacement.next.source, replacement.insert);
  });

  it("refuses to discard environment-level options a fence cannot encode", function () {
    const session = quiverSessionForBlock(fencedBlock("A & B"));
    assert.throws(
      () =>
        sourceForQuiverExport(session, "\\begin{tikzcd}[column sep=large]\nA & B\n\\end{tikzcd}"),
      /cannot store the options Quiver added/,
    );
  });

  it("keeps a raw environment whole when Quiver canonicalises it", function () {
    const session = quiverSessionForBlock(rawBlock("\\begin{tikzcd}\nA & B\n\\end{tikzcd}"));
    const exported = "\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}";
    assert.strictEqual(sourceForQuiverExport(session, exported), exported);
  });

  it("refuses source replacement across Markdown container-marker gaps", function () {
    const block = rawBlock("\\begin{tikzcd}\nA & B\n\\end{tikzcd}");
    block.sourceLineRanges = block.sourceLineRanges.map((range, index) =>
      index === 0 ? range : { from: range.from + 2, to: range.to + 2 },
    );
    assert.throws(() => quiverSessionForBlock(block), /nested inside another Markdown block/u);
  });
});
