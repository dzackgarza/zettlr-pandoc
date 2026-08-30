/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation locator prefix regressions
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Proves words beginning with Roman-numeral letters remain
 *                  intact as citation suffixes while real locators still parse.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import {
  type CiteItem,
  extractCitationNodes,
  nodeToCiteItem,
} from "source/common/modules/markdown-editor/parser/citation-parser";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { renderCitations } from "source/common/modules/markdown-editor/renderers/render-citations";
import { renderPandoc } from "source/common/modules/markdown-editor/renderers/render-pandoc-div-span";
import { markdownSyntaxHighlighter } from "source/common/modules/markdown-editor/theme/syntax";
import {
  configField,
  configUpdateEffect,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";

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

function parseCitationItem(source: string): CiteItem {
  const state = EditorState.create({ doc: source, extensions: [markdownParser()] });
  const nodes = extractCitationNodes(state);
  assert.equal(nodes.length, 1, "the fixture must contain exactly one citation");
  const citation = nodeToCiteItem(nodes[0], source);
  assert.equal(citation.items.length, 1, "the fixture must contain exactly one cite item");
  return citation.items[0];
}

describe("Editor preserves citation suffixes beginning with Roman-numeral letters", function () {
  const views: EditorView[] = [];
  const originalCitationCallback = window.getCitationCallback;

  before(function () {
    polyfillJsdomForCodeMirror();
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
      extensions: [
        markdownParser(),
        markdownSyntaxHighlighter(),
        configField,
        renderPandoc,
        renderCitations,
      ],
    });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    return view;
  }

  it("keeps “Lem. 7.1, 7.2” intact as a citation suffix", function () {
    const item = parseCitationItem("By [@Ols04 Lem. 7.1, 7.2], some result follows.");

    assert.equal(item.locator, undefined);
    assert.equal(item.suffix, " Lem. 7.1, 7.2");
  });

  it("keeps “Cor. 6.2” intact as a citation suffix", function () {
    const item = parseCitationItem("See [@Ols04 Cor. 6.2] for the classification.");

    assert.equal(item.locator, undefined);
    assert.equal(item.suffix, " Cor. 6.2");
  });

  it("renders the lemma suffix without an artificial gap", function () {
    window.getCitationCallback = () => (citations) =>
      citations
        .map((item) => {
          return [item.id, item.locator, item.suffix?.trimStart()]
            .filter((part) => part !== undefined)
            .join(" ");
        })
        .join("; ");
    const doc = "::: theorem\nBy [@Ols04 Lem. 7.1, 7.2], some result follows.\n:::";
    const view = createEditor(doc, doc.indexOf("some result"));
    const citation = view.dom.querySelector<HTMLElement>(".citeproc-citation");

    assert.ok(citation !== null);
    assert.equal(citation.textContent, "Ols04 Lem. 7.1, 7.2");
  });

  it("redraws an open citation after its bibliography becomes available", function () {
    window.getCitationCallback = () => () => undefined;
    const config = getDefaultConfig();
    config.renderingMode = "preview";
    const doc = "See [@Ols04] for the classification.";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownParser(), configField.init(() => config), renderCitations],
    });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    assert.equal(view.dom.querySelector(".citeproc-citation")?.classList.contains("error"), true);

    window.getCitationCallback = () => () => "(Olsson 2004)";
    view.dispatch({ effects: configUpdateEffect.of({ metadata: { ...config.metadata } }) });

    assert.equal(view.dom.querySelector(".citeproc-citation")?.textContent, "(Olsson 2004)");
  });

  it("styles the complete lemma reference as suffix text while editing", function () {
    window.getCitationCallback = () => () => "unused";
    const doc = "::: theorem\nBy [@Ols04 Lem. 7.1, 7.2], some result follows.\n:::";
    const view = createEditor(doc, doc.indexOf("Lem.") + 1);
    const suffix = view.dom.querySelector<HTMLElement>(".cm-citation-suffix");

    assert.ok(suffix !== null);
    assert.equal(suffix.textContent, " Lem. 7.1, 7.2");
  });

  it("continues to parse a genuine Roman-numeral locator", function () {
    const item = parseCitationItem("See [@Ols04 IV] for the classification.");

    assert.equal(item.locator, "IV");
    assert.equal(item.suffix, undefined);
  });

  it("continues to parse a supported explicit locator label", function () {
    const item = parseCitationItem("See [@Ols04 p. 7] for the classification.");

    assert.equal(item.label, "page");
    assert.equal(item.locator, "7");
    assert.equal(item.suffix, undefined);
  });

  it("does not treat an adjacent bracketed citation as a locator suffix of an in-text reference", function () {
    const doc = "@def-higher-category [@nlab:grothendieck_construction]";
    const state = EditorState.create({ doc, extensions: [markdownParser()] });
    const nodes = extractCitationNodes(state);

    assert.equal(nodes.length, 2, "must parse into two separate citation nodes");
    assert.equal(nodeToCiteItem(nodes[0], doc).items[0].id, "def-higher-category");
    assert.equal(nodeToCiteItem(nodes[1], doc).items[0].id, "nlab:grothendieck_construction");
  });
});
