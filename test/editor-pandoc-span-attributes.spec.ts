/**
 * Bracketed Pandoc spans share the same attribute grammar as fenced divs.
 * Nested braces inside quoted values must not terminate the attribute list.
 */

import "./provision-renderer-window-seams";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { renderPandoc } from "source/common/modules/markdown-editor/renderers/render-pandoc-div-span";
import { configField } from "source/common/modules/markdown-editor/util/configuration";

describe("Pandoc bracketed-span attribute parsing", function () {
  it("preserves nested braces and escapes in quoted span attributes", function () {
    const doc = '[Marked]{.mark #span-core title="{\\cite[Thm. 1.1]{AEGS25}}"} outside';
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdownParser(), configField, renderPandoc],
      }),
    });
    try {
      assert.ok(forceParsing(view, doc.length, 5000));
      const marked = view.dom.querySelector<HTMLElement>("#span-core.mark");
      assert.ok(marked !== null, `expected rendered Pandoc span: ${view.dom.innerHTML}`);
      assert.equal(marked.textContent, "Marked");
      assert.equal(marked.getAttribute("title"), "{\\cite[Thm. 1.1]{AEGS25}}");
    } finally {
      view.destroy();
      document.body.replaceChildren();
    }
  });
});
