/** Exact live-preview regression for Pandoc heading levels above six. */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  headingGutter,
  renderHeadings,
} from "source/common/modules/markdown-editor/renderers/render-headings";
import { renderMath } from "source/common/modules/markdown-editor/renderers/render-math";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

describe("Editor renders Pandoc deep headings", function () {
  before(async function () {
    this.timeout(30000);
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
  });

  afterEach(function () {
    document.body.replaceChildren();
  });

  it('renders "####### Type $E$" as a heading with inline math', function () {
    const source = "####### Type $E$\n\nBody.";
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.length },
        extensions: [markdownParser(), configField, headingGutter, renderHeadings, renderMath],
      }),
      parent: document.body,
    });

    const firstLine = view.contentDOM.querySelector<HTMLElement>(".cm-line");
    assert.ok(firstLine !== null);
    assert.doesNotMatch(firstLine.textContent ?? "", /#######/);
    assert.match(firstLine.textContent ?? "", /Type/);
    assert.equal(firstLine.dataset.headingLevel, "7");
    assert.ok(firstLine.classList.contains("cm-pandoc-heading-size-6"));
    assert.ok(firstLine.querySelector(".preview-math mjx-container") !== null);
    view.destroy();
  });

  it("uses semantic levels as data and clamps only the visual size slot", function () {
    const source = "# One\n\n###### Six\n\n####### Seven\n\nTitle\n=====";
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.length },
        extensions: [markdownParser(), headingGutter],
      }),
      parent: document.body,
    });

    const headingLines = [
      ...view.contentDOM.querySelectorAll<HTMLElement>(".cm-pandoc-heading-line"),
    ];
    assert.deepStrictEqual(
      headingLines.map((line) => line.dataset.headingLevel),
      ["1", "6", "7", "1"],
    );
    assert.ok(headingLines[0].classList.contains("cm-pandoc-heading-size-1"));
    assert.ok(headingLines[1].classList.contains("cm-pandoc-heading-size-6"));
    assert.ok(headingLines[2].classList.contains("cm-pandoc-heading-size-6"));
    assert.ok(headingLines[3].classList.contains("cm-pandoc-heading-size-1"));
    view.destroy();
  });
});
