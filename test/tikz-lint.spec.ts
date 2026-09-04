/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ figure linter
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A raw \begin{tikzcd} block written directly under a line of
 *                  prose is a lazy paragraph continuation, so the parser folds
 *                  it into the surrounding paragraph and render-tikz declines
 *                  to draw it. Pandoc reads that same file as a RawBlock and
 *                  exports the figure, so nothing downstream complains and the
 *                  author is left with a figure that silently never appears.
 *
 *                  These cases fix the gutter marker that says so. The
 *                  document shapes are the ones that occur in real writing:
 *                  glued above, glued below, glued on both sides, and the
 *                  separated block that must stay quiet.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { type Diagnostic } from "@codemirror/lint";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { tikzLintSource } from "source/common/modules/markdown-editor/linters/tikz-lint";
import { configField } from "source/common/modules/markdown-editor/util/configuration";

const FIGURE = "\\begin{tikzcd}\nE \\arrow[r] & B\n\\end{tikzcd}";

/**
 * CodeMirror measures through the view's OWN window (`this.win`), which under
 * jsdom is the document's defaultView rather than globalThis — so both need
 * the frame callbacks. Mirrors test/reference-lint.spec.ts, the sibling
 * linter spec.
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

describe("TikZ figure linter", function () {
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

  function lint(doc: string): Diagnostic[] {
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdownParser(), configField],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(forceParsing(view, doc.length, 5000), "the syntax tree must be fully parsed");
    views.push(view);
    return tikzLintSource(view);
  }

  /** The line a diagnostic sits on, 1-based, as the gutter counts. */
  function lineOf(view: EditorView, diagnostic: Diagnostic): number {
    return view.state.doc.lineAt(diagnostic.from).number;
  }

  it("stays silent when the figure is its own paragraph", function () {
    const diagnostics = lint(`A cartesian square\n\n${FIGURE}\n\nThe fibration classifies these.\n`);
    assert.deepEqual(diagnostics, []);
  });

  it("flags a figure glued to the prose above it", function () {
    const doc = `A morphism is small if there is a cartesian square\n${FIGURE}\n\nThe fibration classifies these.\n`;
    const diagnostics = lint(doc);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "error");
    assert.equal(diagnostics[0].source, "tikz-lint");
  });

  it("puts the marker on the \\begin line, which is the line the author must move", function () {
    const doc = `A morphism is small if there is a cartesian square\n${FIGURE}\n\nAfter.\n`;
    const state = EditorState.create({ doc, extensions: [markdownParser(), configField] });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(forceParsing(view, doc.length, 5000));
    views.push(view);
    const [diagnostic] = tikzLintSource(view);
    assert.equal(lineOf(view, diagnostic), 2);
    assert.equal(
      view.state.doc.sliceString(diagnostic.from, diagnostic.to),
      "\\begin{tikzcd}",
      "the marked range must be the opening line itself, not the whole folded paragraph",
    );
  });

  it("flags a figure glued to the prose below it", function () {
    const doc = `A cartesian square\n\n${FIGURE}\nThe fibration classifies these.\n`;
    const diagnostics = lint(doc);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "error");
  });

  it("reports one diagnostic, not two, for a figure glued on both sides", function () {
    const doc = `A cartesian square\n${FIGURE}\nThe fibration classifies these.\n`;
    const diagnostics = lint(doc);
    assert.equal(diagnostics.length, 1);
  });

  it("flags each glued figure in a document that has several", function () {
    const doc =
      `First claim\n${FIGURE}\n\nSecond claim\n${FIGURE}\n\nThird claim\n\n${FIGURE}\n`;
    const diagnostics = lint(doc);
    assert.equal(diagnostics.length, 2, "the third figure is separated and must not be flagged");
  });

  it("flags a glued tikzpicture, not only tikzcd", function () {
    const doc = `A diagram follows\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\nAfter.\n`;
    const diagnostics = lint(doc);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "error");
  });

  it("says nothing about prose that merely mentions the environment name", function () {
    const doc = "Write \\begin{tikzcd} at the start of its own paragraph to draw a diagram.\n";
    assert.deepEqual(lint(doc), []);
  });

  it("says nothing about a fenced tikz block, which renders wherever it sits", function () {
    const doc = "A diagram follows\n```tikz\n\\draw (0,0) -- (1,1);\n```\n";
    assert.deepEqual(lint(doc), []);
  });
});
