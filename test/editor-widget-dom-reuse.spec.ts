import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { renderMath } from "@dzack/pandoc-editor/renderers/render-math";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import { renderCitations } from "source/common/modules/markdown-editor/renderers/render-citations";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

const DOC = "We refer to [@Ols04]$x^2 = y$ afterwards.\n";

describe("Editor keeps renderer widgets in their own DOM", function () {
  const views: EditorView[] = [];
  const originalCitationCallback = window.getCitationCallback;

  before(async function () {
    this.timeout(30000);
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"), {});
  });

  after(function () {
    window.getCitationCallback = originalCitationCallback;
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  it("does not give the math widget the citation widget element", function () {
    window.getCitationCallback = () => () => "(Olsson 2004)";
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: DOC.length - 1 },
      extensions: [markdownParser(), configField, renderCitations, renderMath],
    });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);

    const citation = view.dom.querySelector(".citeproc-citation");
    assert.ok(citation !== null, "the citation must render before the state changes");

    view.dispatch({ selection: { anchor: DOC.indexOf("@Ols04") + 2 } });

    const citationsHoldingMath = view.dom.querySelectorAll(".citeproc-citation mjx-container");
    assert.equal(
      citationsHoldingMath.length,
      0,
      "math must not be rendered into a citation element, which paints the citation background behind it",
    );
    const math = view.dom.querySelector(".preview-math");
    assert.ok(math !== null, "the math must still render as math");
    assert.equal(math.classList.contains("citeproc-citation"), false);
  });
});
