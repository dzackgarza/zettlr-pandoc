import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  visibleSyntaxNodes,
  visitSyntaxNodeGroups,
} from "source/common/modules/markdown-editor/util/visible-syntax-nodes";

describe("shared visible syntax traversal", function () {
  before(function () {
    if (typeof window.requestAnimationFrame !== "function") {
      Object.defineProperties(window, {
        requestAnimationFrame: {
          configurable: true,
          value: (callback: FrameRequestCallback) =>
            Number(setTimeout(() => callback(Date.now()), 0)),
          writable: true,
        },
        cancelAnimationFrame: {
          configurable: true,
          value: (id: number) => clearTimeout(id),
          writable: true,
        },
      });
    }
  });

  function createView(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [markdownParser()],
      }),
    });
  }

  it("reuses one node stream for an unchanged state and visible range", function () {
    const view = createView("# Heading\n\nParagraph with *emphasis* and [link](target).\n");
    try {
      assert.ok(forceParsing(view, view.state.doc.length, 5000));
      const first = visibleSyntaxNodes(view);
      const second = visibleSyntaxNodes(view);
      assert.equal(second, first);

      // Tree.iterate passes a mutable TreeCursor. The cache must hold stable
      // snapshots, not repeated aliases to that cursor's final node.
      const names = first.map(node => node.name);
      assert.ok(names.includes("ATXHeading"), `missing heading from cached stream: ${names.join(", ")}`);
      assert.ok(names.includes("Emphasis"), `missing emphasis from cached stream: ${names.join(", ")}`);
      assert.ok(names.includes("Link"), `missing link from cached stream: ${names.join(", ")}`);
      assert.ok(new Set(first.map(node => `${node.name}:${node.from}:${node.to}`)).size > 3);

      view.dispatch({ selection: { anchor: view.state.doc.length } });
      const afterStateChange = visibleSyntaxNodes(view);
      assert.notEqual(afterStateChange, first);
    } finally {
      view.destroy();
    }
  });

  it("preserves Tree.iterate enter=false descendant suppression", function () {
    const group = [
      { name: "Document", from: 0, to: 30 },
      { name: "FencedCode", from: 0, to: 28 },
      { name: "CodeMark", from: 0, to: 3 },
      { name: "CodeText", from: 6, to: 21 },
      { name: "Paragraph", from: 29, to: 30 },
    ];
    const visited: string[] = [];
    visitSyntaxNodeGroups([group], (node) => {
      visited.push(node.name);
      if (node.name === "FencedCode") {
        return false;
      }
    });
    assert.deepEqual(visited, ["Document", "FencedCode", "Paragraph"]);
  });
});
