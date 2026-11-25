import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import { md2html } from "source/common/modules/markdown-utils/markdown-to-html";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

const RENDER_OPTS = { onCitation: () => undefined, zknLinkFormat: "link|title" as const };

async function rendersAsMath(markdown: string, kind: "display" | "inline"): Promise<boolean> {
  const html = await md2html(markdown, RENDER_OPTS);
  const hasContainer = /<mjx-container/.test(html);
  const isDisplay = /<mjx-container[^>]*display="true"/.test(html);
  return kind === "display" ? hasContainer && isDisplay : hasContainer && !isDisplay;
}

describe("Editor detects LaTeX math delimiters", function () {
  before(async function () {
    this.timeout(30000);
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
  });

  it("$$ … $$ block renders as display math", async function () {
    assert.equal(await rendersAsMath("$$\n\\RR\n$$", "display"), true);
  });

  it("$ … $ renders as inline math", async function () {
    assert.equal(await rendersAsMath("$\\RR$", "inline"), true);
  });

  it("\\[ … \\] block renders as display math", async function () {
    assert.equal(await rendersAsMath("\\[\n\\RR\n\\]", "display"), true);
  });

  it("\\( … \\) renders as inline math", async function () {
    assert.equal(await rendersAsMath("\\(\\RR\\)", "inline"), true);
  });

  it("\\[ … \\] mid-paragraph (after prose, no blank line) renders as display", async function () {
    assert.equal(
      await rendersAsMath("with invariants\n\\[\n\\RR = \\RR\n\\]\nand complement", "display"),
      true,
    );
  });

  it("\\[ … .\\] with the closing delimiter after a trailing period renders as display", async function () {
    assert.equal(
      await rendersAsMath("with invariants\n\\[\n\\RR = \\RR\n.\\]\nand complement", "display"),
      true,
    );
  });
});
