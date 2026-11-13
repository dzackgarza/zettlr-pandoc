/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Specs of the label offer of a display equation
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A display equation is a target of an `eq` label, with
 *                  each of its delimiters: `$$ … $$` and `\[ … \]` (#203).
 *                  The label goes after the closing delimiter, where the
 *                  reference extractor reads it as the definition of the
 *                  equation. The confirmation of the dialog puts the label
 *                  there, also after text above the equation moved it.
 *
 * END HEADER
 */

import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { strict as assert } from "assert";
import {
  confirmReferenceLabelInsertion,
  type ReferenceLabelInsertion,
  resolveCreateReferenceLabelRequest,
} from "source/common/modules/markdown-editor/plugins/create-reference-label";
import { extractReferences } from "source/common/pandoc-util/extract-references";

const EQUATIONS = [
  { delimiters: "$$ … $$", open: "$$", close: "$$" },
  { delimiters: "\\[ … \\]", open: "\\[", close: "\\]" },
];

/** The definition keys of a text after the label `#eq:energy` goes in. */
function definitionsWithLabel(text: string, insertion: ReferenceLabelInsertion): string[] {
  const { from, to, prefix, suffix } = insertion;
  const labelled = `${text.slice(0, from)}${prefix}#eq:energy${suffix}${text.slice(to)}`;
  return extractReferences("", labelled).definitions.map((definition) => definition.key);
}

describe("The label offer of a display equation", function () {
  const views: EditorView[] = [];

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function editor(doc: string): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdownParser()] }),
      parent: document.body,
    });
    views.push(view);
    assert.ok(forceParsing(view, doc.length, 5000), "the syntax tree is parsed");
    return view;
  }

  for (const { delimiters, open, close } of EQUATIONS) {
    const doc = ["The energy is", "", open, "E = mc^2", close, "", "and so on.", ""].join("\n");

    it(`offers an eq label for an equation in ${delimiters}`, function () {
      const view = editor(doc);
      const request = resolveCreateReferenceLabelRequest(view, doc.indexOf("mc^2"));
      assert.ok(request !== null, "the equation offers a label");
      assert.equal(request.family, "eq");
      assert.deepEqual(definitionsWithLabel(doc, request.insertion), ["eq:energy"]);
    });

    it(`puts the confirmed label after the closing ${close}`, function () {
      const view = editor(doc);
      const request = resolveCreateReferenceLabelRequest(view, doc.indexOf("mc^2"));
      assert.ok(request !== null, "the equation offers a label");

      const outcome = confirmReferenceLabelInsertion(view, request);
      assert.ok(outcome.status === "applied", `the confirmation is ${outcome.status}`);
      assert.deepEqual(definitionsWithLabel(doc, outcome.insertion), ["eq:energy"]);
    });

    it(`puts the confirmed label after the closing ${close} when text above moved it`, function () {
      const view = editor(doc);
      const request = resolveCreateReferenceLabelRequest(view, doc.indexOf("mc^2"));
      assert.ok(request !== null, "the equation offers a label");

      // A paragraph arrives above the equation while the dialog is open
      view.dispatch({ changes: { from: 0, to: 0, insert: "A new paragraph.\n\n" } });
      assert.ok(forceParsing(view, view.state.doc.length, 5000), "the syntax tree is parsed");
      const outcome = confirmReferenceLabelInsertion(view, request);
      assert.ok(outcome.status === "applied", `the confirmation is ${outcome.status}`);
      const text = view.state.doc.toString();
      assert.deepEqual(definitionsWithLabel(text, outcome.insertion), ["eq:energy"]);
      assert.equal(
        outcome.insertion.from,
        text.indexOf(close, text.indexOf("mc^2")) + close.length,
      );
    });
  }
});
