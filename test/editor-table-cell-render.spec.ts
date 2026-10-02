/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table-cell renderer contract (issue #23)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks that the renderer set runs inside a table-editor cell
 *                  subview: inline math ($x^2$) authored in a cell must render
 *                  the same way it does in body text (a `.preview-math` widget),
 *                  not stay as raw LaTeX source. Drives the production
 *                  createSubviewForCell over a real main EditorView carrying a
 *                  pipe table, and asserts on the mounted subview's DOM.
 *
 * END HEADER
 */

import "./provision-renderer-window-seams";
// Initialize the renderer/table-editor module graph in the app's order before
// importing the subview directly, so the renderers -> table-editor -> subview
// cycle resolves (webpack tolerates it; a bare tsx import of subview first hits
// a temporal-dead-zone on subviewUpdatePlugin).
import "source/common/modules/markdown-editor/renderers";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { createSubviewForCell } from "source/common/modules/markdown-editor/table-editor/subview";
import {
  configField,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

const DOC = `| Formula |
|---------|
| $x^2$   |
`;

describe("Table-cell rendering (issue #23)", function () {
  const views: EditorView[] = [];

  before(async function () {
    this.timeout(30000);
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  /** A main EditorView carrying the table, in preview mode with math rendering on. */
  function createMainView(): EditorView {
    const config = getDefaultConfig();
    config.renderingMode = "preview";
    config.renderMath = true;
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: 0 },
      extensions: [markdownParser(), configField.init(() => config)],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(forceParsing(view, DOC.length, 5000), "the main syntax tree must be fully parsed");
    views.push(view);
    return view;
  }

  it("renders inline math inside a table cell instead of leaving it as raw source", function () {
    const mainView = createMainView();
    const from = DOC.indexOf("$x^2$");
    const to = from + "$x^2$".length;
    const contentWrapper = document.createElement("div");
    document.body.appendChild(contentWrapper);

    const subview = createSubviewForCell(mainView, contentWrapper, { from, to });
    views.push(subview);
    assert.ok(
      forceParsing(subview, subview.state.doc.length, 5000),
      "the subview syntax tree must be fully parsed",
    );

    const rendered = subview.dom.querySelector<HTMLElement>(".preview-math");
    assert.ok(
      rendered !== null,
      "the cell must render its math as a .preview-math widget, not raw source",
    );
    assert.equal(
      rendered?.dataset.equation,
      "x^2",
      "the rendered math must carry the cell equation",
    );

    // The visible cell text must not still show the raw LaTeX delimiters.
    const cellText = subview.dom.querySelector(".cm-content")?.textContent ?? "";
    assert.ok(
      !cellText.includes("$x^2$"),
      `the raw math source must be replaced, saw: ${cellText}`,
    );
  });
});
