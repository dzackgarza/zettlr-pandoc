/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LaTeX environment linter
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A \begin{…} written directly under a line of prose is a
 *                  lazy paragraph continuation, so the parser folds it into
 *                  that paragraph instead of leaving it a block of its own.
 *
 *                  What that costs depends on the environment, and the two
 *                  cases carry different severities because they need
 *                  different things from the author. A figure environment
 *                  (tikzcd, tikzpicture) is not drawn at all — an error, with
 *                  a fix. Every other environment still renders; it is simply
 *                  part of a paragraph rather than a block, which is a
 *                  warning about the document's shape, not a defect.
 *
 *                  A message that overstated the second case would send the
 *                  author looking for a figure that was never missing, so the
 *                  cases below pin the severity, not just the count.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { type Diagnostic } from "@codemirror/lint";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { latexEnvironmentLintSource } from "source/common/modules/markdown-editor/linters/latex-environment-lint";
import { configField } from "source/common/modules/markdown-editor/util/configuration";

const FIGURE = "\\begin{tikzcd}\nE \\arrow[r] & B\n\\end{tikzcd}";
const ALIGN = "\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}";

/**
 * CodeMirror measures through the view's OWN window (`this.win`), which under
 * jsdom is the document's defaultView rather than globalThis. Mirrors
 * test/reference-lint.spec.ts, the sibling linter spec.
 */
function polyfillJsdomForCodeMirror(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const w = globalThis as any;
  if (typeof w.requestAnimationFrame !== "function") {
    w.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0);
    w.cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  if (typeof w.window === "object" && typeof w.window.requestAnimationFrame !== "function") {
    w.window.requestAnimationFrame = w.requestAnimationFrame;
    w.window.cancelAnimationFrame = w.cancelAnimationFrame;
  }
  if (typeof w.ResizeObserver !== "function") {
    w.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    if (typeof w.window === "object") {
      w.window.ResizeObserver = w.ResizeObserver;
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== "function") {
    w.Range.prototype.getClientRects = () => [];
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe("LaTeX environment linter", function () {
  const views: EditorView[] = [];

  before(function () {
    polyfillJsdomForCodeMirror();
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function viewFor(doc: string): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdownParser(), configField],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(forceParsing(view, doc.length, 5000), "the syntax tree must be fully parsed");
    views.push(view);
    return view;
  }

  function lint(doc: string): Diagnostic[] {
    return latexEnvironmentLintSource(viewFor(doc));
  }

  describe("an environment that is its own block", function () {
    it("says nothing about a separated figure", function () {
      assert.deepEqual(lint(`A cartesian square\n\n${FIGURE}\n\nAfter.\n`), []);
    });

    it("says nothing about a separated equation", function () {
      assert.deepEqual(lint(`Consider the identity\n\n${ALIGN}\n\nAfter.\n`), []);
    });
  });

  describe("a figure folded into its paragraph", function () {
    it("is an error, because it is not drawn at all", function () {
      const diagnostics = lint(`A cartesian square\n${FIGURE}\n\nAfter.\n`);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].severity, "error");
      assert.equal(diagnostics[0].source, "latex-environment-lint");
    });

    it("marks the \\begin line, which is the line the author must move", function () {
      const view = viewFor(`A cartesian square\n${FIGURE}\n\nAfter.\n`);
      const [diagnostic] = latexEnvironmentLintSource(view);
      assert.equal(view.state.doc.lineAt(diagnostic.from).number, 2);
      assert.equal(
        view.state.doc.sliceString(diagnostic.from, diagnostic.to),
        "\\begin{tikzcd}",
      );
    });

    it("flags a folded tikzpicture too", function () {
      const doc = "A diagram follows\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\nAfter.\n";
      assert.equal(lint(doc)[0].severity, "error");
    });
  });

  describe("any other environment folded into its paragraph", function () {
    it("is a warning, not an error: it still renders", function () {
      const diagnostics = lint(`Consider the identity\n${ALIGN}\nwhich holds.\n`);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].severity, "warning");
      assert.equal(diagnostics[0].source, "latex-environment-lint");
    });

    it("warns for a non-math environment as well", function () {
      const doc = "Some prose\n\\begin{center}\nhello\n\\end{center}\n\nAfter.\n";
      const diagnostics = lint(doc);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].severity, "warning");
    });

    it("never calls a rendering equation undrawn", function () {
      const [diagnostic] = lint(`Consider the identity\n${ALIGN}\nwhich holds.\n`);
      assert.equal(
        /not be drawn|will not render|never appears/.test(diagnostic.message),
        false,
        "an equation that renders must not be described as missing",
      );
    });
  });

  describe("what it leaves alone", function () {
    it("says nothing about prose that merely names an environment", function () {
      assert.deepEqual(lint("Write \\begin{tikzcd} at the start of its own paragraph.\n"), []);
    });

    it("says nothing about a fenced tikz block, which renders wherever it sits", function () {
      assert.deepEqual(lint("A diagram follows\n```tikz\n\\draw (0,0) -- (1,1);\n```\n"), []);
    });

    it("says nothing about an environment inside inline math", function () {
      assert.deepEqual(
        lint("The matrix $\\begin{pmatrix}0&1\\\\1&0\\end{pmatrix}$ is hyperbolic.\n"),
        [],
      );
    });
  });

  describe("documents with several", function () {
    it("reports one diagnostic per folded environment", function () {
      const doc = `First\n${FIGURE}\n\nSecond\n${ALIGN}\n\nThird\n\n${FIGURE}\n`;
      const diagnostics = lint(doc);
      assert.equal(diagnostics.length, 2, "the third is separated and must not be flagged");
      assert.deepEqual(
        diagnostics.map((d) => d.severity),
        ["error", "warning"],
        "the figure is an error and the equation a warning, in document order",
      );
    });

    it("reports one diagnostic, not two, for an environment glued on both sides", function () {
      assert.equal(lint(`Before\n${FIGURE}\nAfter.\n`).length, 1);
    });
  });
});
