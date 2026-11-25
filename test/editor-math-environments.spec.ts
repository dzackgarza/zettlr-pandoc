import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { stripMathDelimiters } from "@dzack/pandoc-editor/util/math-delimiters";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import { md2html } from "source/common/modules/markdown-utils/markdown-to-html";
import { initializeMathJax } from "source/common/util/mathtex-to-html";
import { execPandocReference } from "./pandoc-reference";

const RENDER_OPTS = { onCitation: () => undefined, zknLinkFormat: "link|title" as const };
const PANDOC_READER = "markdown+raw_tex+tex_math_dollars+tex_math_single_backslash";

function pandocTreatsEnvironmentAsMath(environment: string): boolean {
  const source = `\\begin{${environment}}\nx = y\n\\end{${environment}}`;
  const raw = execPandocReference(["-f", PANDOC_READER, "-t", "json"], { input: source });
  const document = JSON.parse(raw) as { blocks: Array<{ t: string; c?: unknown }> };
  const first = document.blocks[0];
  if (first?.t !== "Para" || !Array.isArray(first.c)) {
    return false;
  }
  return first.c.some((inline) => {
    return typeof inline === "object" && inline !== null && (inline as { t?: string }).t === "Math";
  });
}

async function rendersAsDisplayMath(markdown: string): Promise<boolean> {
  const html = await md2html(markdown, RENDER_OPTS);
  return /<mjx-container[^>]*display="true"/.test(html);
}

function editorMath(doc: string): { display: boolean; equation: string } | null {
  const state = EditorState.create({ doc, extensions: [markdownParser()] });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  assert.ok(tree !== null, "the document must parse fully before asserting");
  let found: { display: boolean; equation: string } | null = null;
  tree.iterate({
    enter(node) {
      if (found !== null || !["InlineCode", "FencedCode"].includes(node.type.name)) {
        return;
      }
      const firstChild = node.node.firstChild;
      if (firstChild === null || firstChild.type.name !== "CodeMark") {
        return;
      }
      found = stripMathDelimiters(state.sliceDoc(node.from, node.to));
    },
  });
  return found;
}

const ALIGN = "\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}";

describe("Pandoc Markdown LaTeX-environment classification", function () {
  before(async function () {
    this.timeout(60000);
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
  });

  describe("the HTML conversion", function () {
    it("matches Pandoc for standalone LaTeX environment classification", async function () {
      for (const env of [
        "equation",
        "gather",
        "multline",
        "align",
        "align*",
        "flalign",
        "dmath",
        "subequations",
        "cases",
        "matrix",
        "aligned",
        "center",
      ]) {
        const expected = pandocTreatsEnvironmentAsMath(env);
        assert.equal(
          await rendersAsDisplayMath(`\\begin{${env}}\nx = y\n\\end{${env}}`),
          expected,
          `\\begin{${env}} must match Pandoc's block classification`,
        );
      }
    });

    it("leaves a non-math environment as ordinary text", async function () {
      const html = await md2html("\\begin{center}\nhello\n\\end{center}", RENDER_OPTS);
      assert.equal(/<mjx-container/.test(html), false);
      assert.equal(/<code/.test(html), false, "it must not become a code span either");
    });
  });

  describe("the editor preview", function () {
    it("does not reclassify Pandoc raw-TeX environments as Markdown Math nodes", function () {
      assert.equal(editorMath(ALIGN), null);
      assert.equal(editorMath("\\begin{equation}\nx = y\n\\end{equation}"), null);
      assert.equal(editorMath("\\begin{center}\nhello\n\\end{center}"), null);
      assert.equal(editorMath("\\begin{cases}\nx = y\n\\end{cases}"), null);
    });

    it("leaves an unterminated environment alone rather than eating the document", function () {
      assert.equal(editorMath("\\begin{align}\na &= b\n\nA new paragraph."), null);
    });

    it("still renders the dollar forms it always did", function () {
      assert.equal(editorMath("$$\n\\alpha\n$$")?.display, true);
      assert.equal(editorMath("$\\alpha$")?.display, false);
    });

    it("does not fire inside inline math that already delimits an environment", function () {
      const math = editorMath(
        "The matrix $\\begin{pmatrix}0&1\\\\1&0\\end{pmatrix}$ is hyperbolic.",
      );
      assert.equal(math?.display, false, "the dollar delimiters must still win");
      assert.equal(math?.equation, "\\begin{pmatrix}0&1\\\\1&0\\end{pmatrix}");
    });
  });
});
