/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LaTeX environment linter
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Raw non-math LaTeX environments are first-class block
 *                  syntax, matching Pandoc even without surrounding blank
 *                  lines. This linter therefore only reports an environment
 *                  opener that could not be recognized as a complete raw
 *                  block (for example because its closing environment is
 *                  missing). Math environments remain owned by the math
 *                  parser and are never diagnosed here.
 *
 * END HEADER
 */

import { forceParsing } from "@codemirror/language";
import { type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { latexEnvironmentLintSource } from "source/common/modules/markdown-editor/linters/latex-environment-lint";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { configField } from "source/common/modules/markdown-editor/util/configuration";

const FIGURE = "\\begin{tikzcd}\nE \\arrow[r] & B\n\\end{tikzcd}";
const ALIGN = "\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}";

/**
 * CodeMirror measures through the view's OWN window (`this.win`), which under
 * jsdom is the document's defaultView rather than globalThis. Mirrors
 * test/reference-lint.spec.ts, the sibling linter spec.
 */
function polyfillJsdomForCodeMirror(): void {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    const requestFrame = (callback: FrameRequestCallback): number =>
      Number(setTimeout(() => callback(Date.now()), 0));
    const cancelFrame = (id: number): void => {
      clearTimeout(id);
    };
    Object.defineProperties(globalThis, {
      requestAnimationFrame: { configurable: true, value: requestFrame, writable: true },
      cancelAnimationFrame: { configurable: true, value: cancelFrame, writable: true },
    });
  }
  if (typeof window === "object" && typeof window.requestAnimationFrame !== "function") {
    Object.defineProperties(window, {
      requestAnimationFrame: {
        configurable: true,
        value: globalThis.requestAnimationFrame,
        writable: true,
      },
      cancelAnimationFrame: {
        configurable: true,
        value: globalThis.cancelAnimationFrame,
        writable: true,
      },
    });
  }
  if (typeof globalThis.ResizeObserver !== "function") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as typeof ResizeObserver;
    if (typeof window === "object") {
      window.ResizeObserver = globalThis.ResizeObserver;
    }
  }
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () =>
      Object.assign([], {
        item: (_index: number): DOMRect | null => null,
      }) as DOMRectList;
    Range.prototype.getBoundingClientRect = () => ({
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

  describe("well-formed environments", function () {
    it("says nothing about a separated figure", function () {
      assert.deepEqual(lint(`A cartesian square\n\n${FIGURE}\n\nAfter.\n`), []);
    });

    it("says nothing about a separated equation", function () {
      assert.deepEqual(lint(`Consider the identity\n\n${ALIGN}\n\nAfter.\n`), []);
    });

    it("recognizes a raw figure immediately after prose without a blank line", function () {
      assert.deepEqual(lint(`A cartesian square\n${FIGURE}\nAfter.\n`), []);
    });

    it("recognizes an ordinary raw LaTeX block immediately after prose", function () {
      const center = "\\begin{center}\nhello\n\\end{center}";
      assert.deepEqual(lint(`Some prose\n${center}\nAfter.\n`), []);
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

  describe("malformed raw environments", function () {
    it("reports an unterminated figure opener as an error", function () {
      const doc = "Before.\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n";
      const diagnostics = lint(doc);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].severity, "error");
      assert.equal(diagnostics[0].source, "latex-environment-lint");
      assert.match(diagnostics[0].message, /matching \\end\{tikzpicture\}/);
    });

    it("reports an unterminated non-figure raw environment as a warning", function () {
      const diagnostics = lint("Before.\n\\begin{center}\ntext\n");
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].severity, "warning");
    });

    it("does not diagnose a math environment owned by the math parser", function () {
      assert.deepEqual(lint(`Before.\n${ALIGN}\nAfter.\n`), []);
    });
  });
});
