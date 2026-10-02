/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reattach-selection resolver specs (M10)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves the rule MainEditor.vue's reattachAnnotation
 *                  enforces, over a real EditorView — the same
 *                  boundary annotation-context-menu.spec.ts proves
 *                  resolveAnnotateSelectionMenuItem against. S8/I6: an
 *                  orphaned anchor comes back to `range` ONLY through a
 *                  range the owner actually selected; a collapsed cursor
 *                  must refuse rather than fabricate a point.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { resolveReattachSelection } from "source/win-main/util/annotation-reattach-selection";

const DOC = "Something else entirely.\nWritten by another program.\n";

describe("Reattach-selection resolver (M10, S8/I6)", function () {
  const views: EditorView[] = [];

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function editorWithSelection(from: number, to: number): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, selection: { anchor: from, head: to } }),
      parent: document.body,
    });
    views.push(view);
    return view;
  }

  it("refuses a collapsed cursor rather than fabricating a point range (I6: no background guess)", function () {
    const cursor = DOC.indexOf("another program");
    const view = editorWithSelection(cursor, cursor);
    assert.deepEqual(resolveReattachSelection(view), { ok: false, reason: "empty-selection" });
  });

  it("reports the exact range the owner selected, coordinate for coordinate", function () {
    const from = DOC.indexOf("another program");
    const to = from + "another program".length;
    const view = editorWithSelection(from, to);
    assert.deepEqual(resolveReattachSelection(view), { ok: true, from, to });
  });
});
