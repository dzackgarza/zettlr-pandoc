import { strict as assert } from "node:assert";
import { EditorState } from "@codemirror/state";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { activeTikzBlock } from "source/common/modules/markdown-editor/tikz-block";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import {
  quiverReplacement,
  quiverSessionForBlock,
  quiverSourceForSession,
  sourceForQuiverExport,
} from "tikz-workbench/src/quiver-bridge";
import type { TikzSourceBlock } from "tikz-workbench/src/source-block";
import { contiguousSourceLineRanges } from "tikz-workbench/src/source-block";

function rawBlock(source: string): TikzSourceBlock & { authoredSource: string } {
  return {
    from: 10,
    to: 10 + source.length,
    sourceFrom: 10,
    sourceTo: 10 + source.length,
    source,
    authoredSource: source,
    sourceLineRanges: contiguousSourceLineRanges(source, 10),
    kind: "raw",
    language: "tikzcd",
  };
}

function fencedBlock(body: string): TikzSourceBlock & { authoredSource: string } {
  return {
    from: 20,
    to: 20 + body.length + 14,
    sourceFrom: 30,
    sourceTo: 30 + body.length,
    source: body,
    authoredSource: body,
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

  it("writes Quiver edits back into a list without changing its Markdown prefixes", function () {
    const doc =
      "- Diagram:\n\n  \\begin{tikzcd}\n  X \\arrow[r] & Y\n  \\end{tikzcd}\n\n- Next item\n";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("\\arrow") },
      extensions: [markdownParser(), configField],
    });
    const block = activeTikzBlock(state);
    assert.ok(block);
    const session = quiverSessionForBlock({
      ...block,
      authoredSource: doc.slice(block.sourceFrom, block.sourceTo),
    });
    const exported = '\\begin{tikzcd}\nX \\arrow[r, "f"] & Y \\\\\nP & Q\n\\end{tikzcd}';
    const replacement = quiverReplacement(session, exported);
    const changed = state.update({ changes: replacement }).state.doc.toString();
    assert.ok(changed.includes('  X \\arrow[r, "f"] & Y \\\\\n  P & Q\n  \\end{tikzcd}'));
    assert.ok(changed.endsWith("\n- Next item\n"));
    assert.equal(replacement.next.source, exported);
    assert.equal(replacement.next.authoredSource, replacement.insert);
  });

  it("rejects inconsistent Markdown line prefixes", function () {
    const block = rawBlock("\\begin{tikzcd}\nX & Y\n\\end{tikzcd}");
    block.authoredSource = block.source.replace("\n", "\n  ").replace("\n\\end", "\n> \\end");
    block.sourceLineRanges = block.sourceLineRanges.map((range, index) =>
      index === 0 ? range : { from: range.from + 2 * index, to: range.to + 2 * index },
    );
    block.sourceTo = block.sourceFrom + block.authoredSource.length;
    assert.throws(() => quiverSessionForBlock(block), /Diagram line 3 uses Markdown prefix/u);
  });
});
