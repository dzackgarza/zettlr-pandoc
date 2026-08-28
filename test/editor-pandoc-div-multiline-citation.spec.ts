/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Multiline citation rendering inside Pandoc fenced divs
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Proves line-wrapped Pandoc citations can participate in
 *                  cursor-local live preview inside semantic fenced divs.
 *
 * END HEADER
 */

import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { renderCitations } from "source/common/modules/markdown-editor/renderers/render-citations";
import { renderMath } from "source/common/modules/markdown-editor/renderers/render-math";
import { renderPandoc } from "source/common/modules/markdown-editor/renderers/render-pandoc-div-span";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

function polyfillJsdomForCodeMirror(): void {
  const global = globalThis as any;
  if (typeof global.requestAnimationFrame !== "function") {
    global.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0);
    global.cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  if (
    typeof global.window === "object" &&
    typeof global.window.requestAnimationFrame !== "function"
  ) {
    global.window.requestAnimationFrame = global.requestAnimationFrame;
    global.window.cancelAnimationFrame = global.cancelAnimationFrame;
  }
  if (typeof global.ResizeObserver !== "function") {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    if (typeof global.window === "object") {
      global.window.ResizeObserver = global.ResizeObserver;
    }
  }
  if (typeof global.Range?.prototype.getClientRects !== "function") {
    global.Range.prototype.getClientRects = () => [];
    global.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }
}

describe("Editor renders line-wrapped citations inside Pandoc fenced divs", function () {
  const views: EditorView[] = [];
  const originalCitationCallback = window.getCitationCallback;

  before(async function () {
    this.timeout(30000);
    polyfillJsdomForCodeMirror();
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
    window.getCitationCallback = () => (citations) =>
      citations.map((citation) => citation.id).join("; ");
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

  function createEditor(doc: string, anchor: number): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownParser(), configField, renderPandoc, renderCitations, renderMath],
    });
    const view = new EditorView({ state, parent: document.body });
    // On a cold parser the markdown parse can miss CodeMirror's synchronous
    // time slice, leaving the first render with a partial tree while these
    // specs assert synchronously. forceParsing completes the parse and applies
    // the resulting tree through a real view update.
    assert.ok(
      forceParsing(view, doc.length, 5000),
      "the syntax tree must be fully parsed before asserting",
    );
    views.push(view);
    return view;
  }

  function renderedCitations(view: EditorView): string[] {
    return [...view.dom.querySelectorAll<HTMLElement>(".citeproc-citation")].map(
      (element) => element.textContent ?? "",
    );
  }

  const morrisonFixture = `# Morrison's degenerations

::: remark

Flower pots correspond to type $\\mathrm{(i.b)}$ in the classification [@Ols04
Cor. 6.2], which remains semistable.
:::

outside`;

  it("opens an active div containing the Morrison line-wrapped citation", function () {
    let view: EditorView | undefined;
    assert.doesNotThrow(() => {
      view = createEditor(morrisonFixture, morrisonFixture.indexOf("Flower pots"));
    });

    assert.ok(view !== undefined);
    assert.ok(view.dom.querySelector("pandoc-div-active-wrapper") !== null);
    assert.deepStrictEqual(renderedCitations(view), ["Ols04"]);
  });

  it("opens an inactive div containing the Morrison line-wrapped citation", function () {
    let view: EditorView | undefined;
    assert.doesNotThrow(() => {
      view = createEditor(morrisonFixture, morrisonFixture.length);
    });

    assert.ok(view !== undefined);
    assert.ok(view.dom.querySelector("pandoc-div-wrapper") !== null);
    assert.deepStrictEqual(renderedCitations(view), ["Ols04"]);
  });

  it("keeps the document editable after mounting a wrapped citation", function () {
    let view: EditorView | undefined;
    assert.doesNotThrow(() => {
      view = createEditor(morrisonFixture, morrisonFixture.indexOf("Flower pots"));
    });

    assert.ok(view !== undefined);
    const insertion = morrisonFixture.indexOf("Flower pots") + "Flower pots".length;
    view.dispatch({ changes: { from: insertion, insert: " still" } });
    assert.match(view.state.doc.toString(), /Flower pots still correspond/);
    assert.deepStrictEqual(renderedCitations(view), ["Ols04"]);
  });

  it("keeps a second wrapped citation rendered while the first citation is selected", function () {
    const doc = `::: theorem
First [@Ols04
Cor. 6.2] and second [@AEGS23
Rmk. 4.12].
:::

outside`;
    let view: EditorView | undefined;
    assert.doesNotThrow(() => {
      view = createEditor(doc, doc.indexOf("@Ols04") + 2);
    });

    assert.ok(view !== undefined);
    assert.deepStrictEqual(renderedCitations(view), ["AEGS23"]);
    assert.match(view.dom.textContent ?? "", /\[@Ols04Cor\. 6\.2\]/);
    assert.match(view.state.doc.toString(), /\[@Ols04\nCor\. 6\.2\]/);
  });

  it("keeps a wrapped citation rendered while a neighboring equation is selected", function () {
    const doc = `::: remark
The class $x=y$ occurs in [@Ols04
Cor. 6.2].
:::

outside`;
    let view: EditorView | undefined;
    assert.doesNotThrow(() => {
      view = createEditor(doc, doc.indexOf("x=y") + 1);
    });

    assert.ok(view !== undefined);
    assert.deepStrictEqual(renderedCitations(view), ["Ols04"]);
    assert.equal(
      view.dom.querySelector(".preview-math"),
      null,
      "the selected equation must remain raw",
    );
    assert.match(view.dom.textContent ?? "", /\$x=y\$/);
  });

  it("continues to render a single-line citation inside an active div", function () {
    const doc = "::: remark\nText [@Ols04].\n:::\n\noutside";
    const view = createEditor(doc, doc.indexOf("Text"));

    assert.deepStrictEqual(renderedCitations(view), ["Ols04"]);
  });

  it("leaves a selected wrapped citation raw without throwing", function () {
    const doc = "::: remark\nText [@Ols04\nCor. 6.2].\n:::\n\noutside";
    const view = createEditor(doc, doc.indexOf("@Ols04") + 2);

    assert.deepStrictEqual(renderedCitations(view), []);
    assert.match(view.state.doc.toString(), /\[@Ols04\nCor\. 6\.2\]/);
  });

  it("leaves malformed citation source raw as a control", function () {
    const doc = "::: remark\nText [Ols04\nCor. 6.2.\n:::\n\noutside";
    const view = createEditor(doc, doc.indexOf("Text"));

    assert.deepStrictEqual(renderedCitations(view), []);
    assert.match(view.state.doc.toString(), /\[Ols04\nCor\. 6\.2\./);
  });
});
