/**
 * Product-contract tests for the in-app Pandoc quick reference.
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import openPandocQuickHelp from "source/app/service-providers/menu/open-pandoc-quick-help";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { renderCitations } from "source/common/modules/markdown-editor/renderers/render-citations";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import {
  isSupportedPandocCrossref,
  PANDOC_ATTRIBUTE_EXAMPLES,
  PANDOC_CITATION_EXAMPLES,
  PANDOC_CROSS_REFERENCE_EXAMPLES,
  PANDOC_REFERENCE_MODIFIERS,
} from "source/common/util/pandoc-quick-reference";

describe("Pandoc quick reference", function () {
  afterEach(function () {
    document.body.replaceChildren();
  });

  it("opens in the focused editor window through the application shortcut channel", function () {
    const messages: Array<[string, string]> = [];

    openPandocQuickHelp({
      webContents: {
        send: (channel, shortcut) => messages.push([channel, shortcut]),
      },
    });

    assert.deepStrictEqual(messages, [["shortcut", "pandoc-quick-help"]]);
  });

  it("documents the five cross-reference families rendered by the editor", function () {
    // lst joined the launch families with issue #1 (workspace-resolved
    // references); the earlier four-family pin predated that contract.
    assert.deepStrictEqual(
      PANDOC_CROSS_REFERENCE_EXAMPLES.map((example) => example.prefix),
      ["fig", "tbl", "eq", "sec", "lst"],
    );
    assert.equal(isSupportedPandocCrossref("tbl:comparison"), true);
    assert.equal(isSupportedPandocCrossref("tab:comparison"), false);
    assert.equal(isSupportedPandocCrossref("lst:algorithm"), true);
  });

  it("pairs every cross-reference label with the reference that cites it", function () {
    for (const example of PANDOC_CROSS_REFERENCE_EXAMPLES) {
      assert.match(example.label, new RegExp(`\\{#${example.prefix}:key\\}`));
      assert.equal(example.reference, `@${example.prefix}:key`);
    }
  });

  it("shows the table ID on a fence around its caption", function () {
    const table = PANDOC_CROSS_REFERENCE_EXAMPLES.find((example) => example.kind === "table");
    assert.equal(
      table?.label,
      "::: {#tbl:key}\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n: Caption\n\n:::",
    );
  });

  it("covers citation locators, prefixes, suffixes, groups, and author suppression", function () {
    const syntax = PANDOC_CITATION_EXAMPLES.map((example) => example.syntax);

    assert.ok(syntax.includes("[@Ols04, pp. 7-9]"));
    assert.ok(syntax.includes("[see @Ols04, Lem. 7.1]"));
    assert.ok(syntax.includes("[see @Ols04; @AEGS23]"));
    assert.ok(syntax.includes("Smith argues this [-@Smith04]."));
  });

  it("covers grouped and modified references plus Pandoc block and inline attributes", function () {
    assert.deepStrictEqual(
      PANDOC_REFERENCE_MODIFIERS.map((example) => example.syntax),
      ["[@fig:first; @fig:second]", "[See @fig:key]", "[-@fig:key]"],
    );
    assert.deepStrictEqual(
      PANDOC_ATTRIBUTE_EXAMPLES.map((example) => example.kind),
      ["attributes", "fenced-div", "bracketed-span"],
    );
  });

  it("renders the documented cross-reference prefix-suppression form", function () {
    const doc = "See [-@fig:key].\n\noutside";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownParser(), configField, renderCitations],
    });
    const view = new EditorView({ state, parent: document.body });
    const rendered = view.dom.querySelector(".citeproc-citation")?.textContent;

    assert.equal(rendered, "#key");
    view.destroy();
  });
});
