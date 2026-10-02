/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown parse scaling
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The main process parses a document for each reader of its
 *                  AST. The parse time must follow the length of the document,
 *                  and one text has one AST for all readers.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { markdownToAST } from "source/common/modules/markdown-utils";

/** Paragraphs with a raw TeX command on a line of its own, as in a document of mathematics. */
function paragraphs(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      `The even lattice $L_{${i}}$ of rank ${i} has a root.\n\\medskip\nEach root of $L_{${i}}$ has norm 2.\n`,
    );
  }
  return parts.join("\n");
}

/** The shortest of five parses of `text`, in milliseconds. */
function parseTime(text: string): number {
  const { parser } = markdownParser().language;
  let shortest = Infinity;
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const tree = parser.parse(text);
    shortest = Math.min(shortest, performance.now() - start);
    assert.equal(tree.length, text.length, "the parse must cover the document");
  }
  return shortest;
}

describe("The Markdown parser", function () {
  it("parses a document of four times the length in less than eight times the time", function () {
    const short = paragraphs(300);
    const long = paragraphs(1200);
    assert.ok(long.length > 3.9 * short.length);
    parseTime(paragraphs(100));

    const shortTime = parseTime(short);
    const longTime = parseTime(long);
    assert.ok(
      longTime < 8 * shortTime,
      `${short.length} characters took ${shortTime.toFixed(1)} ms and ${long.length} characters took ${longTime.toFixed(1)} ms`,
    );
  });
});

describe("markdownToAST", function () {
  it("gives each reader of one text the same AST, and a new AST for a changed text", function () {
    const text = paragraphs(20);
    const first = markdownToAST(text);
    assert.equal(first.type, "Document");
    assert.equal(markdownToAST(text), first);

    const changed = markdownToAST(text + "\nA new paragraph.\n");
    assert.notEqual(changed, first);
    assert.equal(changed.to, text.length + "\nA new paragraph.\n".length);
    assert.equal(markdownToAST(text), first);
  });
});
