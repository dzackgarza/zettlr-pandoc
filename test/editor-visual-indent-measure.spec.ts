import { EditorView } from "@codemirror/view";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { softwrapVisualIndent } from "@dzack/pandoc-editor/plugins/visual-indent";
import { strict as assert } from "assert";

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number): void => {
      if (left === 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

describe("Visual indent measures the document of the measurement", function () {
  it("reports no error when the document gets shorter before a measurement", async function () {
    const exceptions: unknown[] = [];
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      doc: "First paragraph.\n\n    An indented line of the text of the file.\n",
      extensions: [
        markdownParser(),
        softwrapVisualIndent,
        EditorView.exceptionSink.of((exception) => {
          exceptions.push(exception);
        }),
      ],
      parent,
    });
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Short." } });
      await nextFrames(3);
      assert.deepEqual(
        exceptions.map((exception) => String(exception)),
        [],
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
