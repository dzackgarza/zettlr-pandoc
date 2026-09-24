/** Raw-block compiler diagnostics map through parser-owned authored line ranges. */

import { strict as assert } from "assert";
import { collectTikzCompilerFindings } from "source/app/util/tikz-compiler-findings";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";

const failure: TikzRenderResult = {
  ok: false,
  kind: "compile-error",
  errors: [
    {
      line: 2,
      message: "Undefined control sequence.",
      sourceLine: "\\draw \\nope;",
    },
  ],
  log: "! Undefined control sequence.\n",
};

async function compilerFindings(
  markdown: string,
): Promise<Awaited<ReturnType<typeof collectTikzCompilerFindings>>> {
  return await collectTikzCompilerFindings(
    markdown,
    "/notes/example.md",
    async (_request: TikzRenderRequest) => failure,
  );
}

describe("TikZ compile diagnostics for structural raw blocks", function () {
  it("maps a blockquote raw-block error to the authored TikZ line, not the quote marker", async function () {
    const doc = [
      "> Before.",
      ">",
      "> \\begin{tikzpicture}",
      ">   \\draw \\nope;",
      "> \\end{tikzpicture}",
      "",
    ].join("\n");
    const [diagnostic] = await compilerFindings(doc);
    assert.ok(diagnostic !== undefined);
    assert.strictEqual(doc.slice(diagnostic.from, diagnostic.to), "  \\draw \\nope;");
  });

  it("maps a list-item raw-block error after container indentation is stripped semantically", async function () {
    const doc = [
      "- Before.",
      "",
      "  \\begin{tikzpicture}",
      "    \\draw \\nope;",
      "  \\end{tikzpicture}",
      "",
    ].join("\n");
    const [diagnostic] = await compilerFindings(doc);
    assert.ok(diagnostic !== undefined);
    assert.strictEqual(doc.slice(diagnostic.from, diagnostic.to), "  \\draw \\nope;");
  });
});
