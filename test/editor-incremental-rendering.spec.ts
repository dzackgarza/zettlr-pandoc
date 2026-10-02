/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Incremental block widget rendering
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The block widget field renders again only what a
 *                  transaction can change. These tests state the two halves
 *                  of that contract: the work of a transaction does not
 *                  follow the length of the document, and the widgets after
 *                  a sequence of transactions are the widgets that a new
 *                  editor shows for the same document and selection.
 *
 * END HEADER
 */

// The renderer aggregate reads the preload bridge when it is imported.
import "./provision-renderer-window-seams";
import { ensureSyntaxTree, forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  type EditorWorkspaceReferences,
  workspaceReferencesField,
  workspaceReferencesUpdate,
} from "source/common/modules/markdown-editor/plugins/workspace-references-field";
import { renderers } from "source/common/modules/markdown-editor/renderers";
import { renderBlockWidgets } from "source/common/modules/markdown-editor/renderers/base-renderer";
import {
  configField,
  configUpdateEffect,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { resolveWorkspace } from "source/common/pandoc-util/resolve-references";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

class MathMarker extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: MathMarker): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    return document.createElement("span");
  }
}

interface CountedEditor {
  state: EditorState;
  /** The number of widgets that the renderer made since the last reset. */
  made: () => number;
  reset: () => void;
}

/** The syntax tree of a state covers the whole document only after this. */
function parsed(state: EditorState): EditorState {
  assert.notEqual(
    ensureSyntaxTree(state, state.doc.length, 60_000),
    null,
    "the document must parse",
  );
  return state.update({}).state;
}

function countedEditor(doc: string, anchor: number): CountedEditor {
  let made = 0;
  const renderer = renderBlockWidgets(
    ["InlineCode", "FencedCode"],
    () => true,
    (state, node) => {
      made += 1;
      return new MathMarker(state.sliceDoc(node.from, node.to));
    },
  );
  const state = parsed(
    EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownParser(), configField, renderer],
    }),
  );
  return {
    state,
    made: () => made,
    reset: () => {
      made = 0;
    },
  };
}

function paragraphs(count: number): string {
  let doc = "";
  for (let i = 0; i < count; i++) {
    doc += `Paragraph ${i} holds $x_{${i}}$ and $y_{${i}}$ in a sentence.\n\n`;
  }
  return doc;
}

function widgets(state: EditorState): string[] {
  const found: string[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    // The block widget field provides a set; no extension of these states provides a function.
    const set = source as DecorationSet;
    const cursor = set.iter();
    while (cursor.value !== null) {
      found.push(`${cursor.from}-${cursor.to}:${state.sliceDoc(cursor.from, cursor.to)}`);
      cursor.next();
    }
  }
  return found.sort();
}

describe("Block widgets follow the size of a change", function () {
  this.timeout(120_000);

  function widgetsMadeByTypedCharacter(paragraphCount: number): number {
    const doc = paragraphs(paragraphCount);
    const editor = countedEditor(doc, 0);
    const position = doc.indexOf("holds", doc.length / 2);
    editor.reset();
    const typed = editor.state.update({
      changes: { from: position, insert: "x" },
      selection: { anchor: position + 1 },
    }).state;
    assert.equal(widgets(typed).length, 2 * paragraphCount);
    return editor.made();
  }

  it("makes the same number of widgets for a typed character in a short and in a long document", function () {
    const short = widgetsMadeByTypedCharacter(40);
    const long = widgetsMadeByTypedCharacter(4000);
    assert.equal(long, short);
    assert.ok(short <= 4, `a typed character made ${short} widgets`);
  });

  it("makes no widget when the cursor moves through text", function () {
    const doc = paragraphs(400);
    const position = doc.indexOf("Paragraph 200");
    const editor = countedEditor(doc, position);
    editor.reset();
    let state = editor.state;
    for (let step = 1; step <= 8; step++) {
      state = state.update({ selection: { anchor: position + step } }).state;
    }
    assert.equal(editor.made(), 0);
    assert.equal(widgets(state).length, 800);
  });

  it("shows the source under the cursor and renders it again when the cursor leaves", function () {
    const doc = paragraphs(3);
    const math = doc.indexOf("$x_{1}$");
    const editor = countedEditor(doc, 0);
    const inside = editor.state.update({ selection: { anchor: math + 2 } }).state;
    assert.deepEqual(widgets(inside), widgets(countedEditor(doc, math + 2).state));
    assert.equal(widgets(inside).length, 5);
    const outside = inside.update({ selection: { anchor: 0 } }).state;
    assert.equal(widgets(outside).length, 6);
  });

  it("has the widgets of a new editor after each of a sequence of edits", function () {
    const doc = paragraphs(30);
    const at = (needle: string, state: EditorState): number => {
      const position = state.sliceDoc().indexOf(needle);
      assert.notEqual(position, -1, `the document must contain ${needle}`);
      return position;
    };
    const edits: Array<(state: EditorState) => TransactionSpec> = [
      (state) => ({ changes: { from: at("holds $x_{4}$", state), insert: "now " } }),
      (state) => ({
        changes: { from: at("$y_{7}$", state), to: at("$y_{7}$", state) + 7, insert: "" },
      }),
      (state) => ({ changes: { from: at("Paragraph 9 ", state), insert: "New $z$ block.\n\n" } }),
      (state) => ({
        changes: { from: at("Paragraph 12 ", state), to: at("Paragraph 14 ", state), insert: "" },
      }),
      (state) => ({ changes: { from: at(" and $y_{15}$", state), insert: "\n\n" } }),
      (state) => ({
        changes: { from: at("Paragraph 18 ", state), insert: "```\ncode $a$\n```\n\n" },
      }),
      (state) => ({
        changes: { from: at("```\ncode", state), to: at("```\ncode", state) + 1, insert: "" },
      }),
      (state) => ({ selection: { anchor: at("$x_{20}$", state) + 3 } }),
      (state) => ({ changes: { from: at("x_{20}", state), insert: "q" } }),
      () => ({ selection: { anchor: 0 } }),
      (state) => ({ changes: { from: state.doc.length, insert: "Last $w$ line.\n" } }),
      (state) => ({ changes: { from: 0, to: at("Paragraph 2 ", state), insert: "" } }),
      (state) => ({
        changes: [
          { from: at("$x_{3}$", state) + 1, insert: "a" },
          { from: at("$x_{25}$", state) + 1, insert: "b" },
        ],
      }),
    ];

    let state = countedEditor(doc, 0).state;
    for (const [index, edit] of edits.entries()) {
      state = parsed(state.update(edit(state)).state);
      const fresh = countedEditor(state.sliceDoc(), state.selection.main.anchor).state;
      assert.deepEqual(widgets(state), widgets(fresh), `edit ${index}`);
    }
  });
});

const AGGREGATE_DOC = `---
title: Lattices
tags: [forms, surfaces]
---

# Lattices {#sec:lattices}

A paragraph with $x^2$ and *emphasis* and a [link](https://example.org).

::: {.theorem #thm:main title="Main theorem"}
Every even unimodular lattice $L$ of signature $(1, 9)$ is isometric to $E_{10}$.

$$
q(x) = x^2
$$
:::

| Lattice | Rank |
|---------|------|
| $U$     | 2    |
| $E_8$   | 8    |

- [ ] an open task
- [x] a done task

> A quotation with **strong** text.

---

See [@Ols04] and @thm:main for the proof.

\`\`\`python
print(1)
\`\`\`

Closing paragraph.
`;

interface Drawn {
  from: number;
  to: number;
  decoration: Decoration;
}

describe("The production renderers", function () {
  this.timeout(120_000);
  const views: EditorView[] = [];

  before(async function () {
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  /** The reference view that the main process sends for a document. */
  function referenceView(doc: string): EditorWorkspaceReferences {
    const snapshot = extractReferences("edited-document.md", doc);
    return {
      snapshot,
      workspaceOccurrences: snapshot.occurrences,
      resolutions: resolveWorkspace([snapshot]),
    };
  }

  function parsedView(view: EditorView): EditorView {
    assert.ok(forceParsing(view, view.state.doc.length, 60_000), "the document must parse");
    view.dispatch({ effects: workspaceReferencesUpdate.of(referenceView(view.state.sliceDoc())) });
    return view;
  }

  function createEditor(doc: string, selection: EditorSelection): EditorView {
    const config = getDefaultConfig();
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          markdownParser(),
          configField.init(() => config),
          workspaceReferencesField,
          renderers(config),
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    return parsedView(view);
  }

  function drawn(view: EditorView): Drawn[] {
    const found: Drawn[] = [];
    for (const source of view.state.facet(EditorView.decorations)) {
      const set = typeof source === "function" ? source(view) : source;
      const cursor = set.iter();
      while (cursor.value !== null) {
        found.push({ from: cursor.from, to: cursor.to, decoration: cursor.value });
        cursor.next();
      }
    }
    return found;
  }

  function describeDrawn(view: EditorView, item: Drawn | undefined): string {
    if (item === undefined) {
      return "nothing";
    }
    const widget: WidgetType | undefined = item.decoration.spec.widget;
    const kind = widget?.constructor.name ?? JSON.stringify(item.decoration.spec);
    return `${kind} at ${item.from}-${item.to} (${JSON.stringify(view.state.sliceDoc(item.from, item.to).slice(0, 40))})`;
  }

  function sameDecoration(a: Decoration, b: Decoration): boolean {
    const widget: WidgetType | undefined = a.spec.widget;
    const other: WidgetType | undefined = b.spec.widget;
    // A widget class without an `eq` of its own is equal only to itself. Two
    // such widgets of one class over the same source show the same content.
    if (widget !== undefined && other !== undefined && widget.eq === WidgetType.prototype.eq) {
      return widget.constructor === other.constructor;
    }
    return a.eq(b);
  }

  function assertSameDrawing(edited: EditorView, fresh: EditorView, step: string): void {
    const a = drawn(edited);
    const b = drawn(fresh);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const same =
        a[i] !== undefined &&
        b[i] !== undefined &&
        a[i].from === b[i].from &&
        a[i].to === b[i].to &&
        sameDecoration(a[i].decoration, b[i].decoration);
      assert.ok(
        same,
        `${step}: the edited editor draws ${describeDrawn(edited, a[i])}, a new editor draws ${describeDrawn(fresh, b[i])}`,
      );
    }
  }

  it("draw an edited document as a new editor draws it, after each of a sequence of edits and caret moves", function () {
    const at = (needle: string, state: EditorState): number => {
      const position = state.sliceDoc().indexOf(needle);
      assert.notEqual(position, -1, `the document must contain ${needle}`);
      return position;
    };
    const steps: Array<[string, (state: EditorState) => TransactionSpec]> = [
      [
        "text typed in a paragraph",
        (state) => ({ changes: { from: at("with $x^2$", state), insert: "now " } }),
      ],
      [
        "a front matter value changed",
        (state) => ({ changes: { from: at("Lattices\ntags", state), insert: "Even " } }),
      ],
      [
        "the caret in the front matter",
        (state) => ({ selection: { anchor: at("tags:", state) + 2 } }),
      ],
      [
        "the caret in the last paragraph",
        (state) => ({ selection: { anchor: at("Closing", state) + 3 } }),
      ],
      [
        "the title of a div changed",
        (state) => ({ changes: { from: at("Main theorem", state) + 4, insert: " structure" } }),
      ],
      [
        "text typed in a div",
        (state) => ({ changes: { from: at("Every even", state), insert: "Up to isometry. " } }),
      ],
      [
        "the caret in a div header",
        (state) => ({ selection: { anchor: at(".theorem", state) + 2 } }),
      ],
      [
        "the closing fence of a div deleted",
        (state) => ({
          changes: { from: at("$$\n:::", state) + 3, to: at("$$\n:::", state) + 6, insert: "" },
        }),
      ],
      [
        "the closing fence written again",
        (state) => ({ changes: { from: at("$$\n\n\n| Lattice", state) + 3, insert: ":::" } }),
      ],
      ["the caret in a table cell", (state) => ({ selection: { anchor: at("| 8 ", state) + 2 } })],
      [
        "a table cell changed",
        (state) => ({
          changes: { from: at("| 8 ", state) + 2, to: at("| 8 ", state) + 3, insert: "9" },
        }),
      ],
      [
        "a table row added",
        (state) => ({
          changes: { from: at("- [ ] an open", state) - 1, insert: "| $D_4$   | 4    |\n" },
        }),
      ],
      ["the caret in inline math", (state) => ({ selection: { anchor: at("$x^2$", state) + 2 } })],
      [
        "inline math changed",
        (state) => ({ changes: { from: at("x^2$ and", state) + 3, insert: "0" } }),
      ],
      [
        "a task checked",
        (state) => ({
          changes: {
            from: at("[ ] an open", state) + 1,
            to: at("[ ] an open", state) + 2,
            insert: "x",
          },
        }),
      ],
      [
        "a paragraph added before the first heading",
        (state) => ({
          changes: { from: at("# Lattices", state), insert: "An opening $a$ paragraph.\n\n" },
        }),
      ],
      [
        "a heading deleted",
        (state) => ({
          changes: { from: at("# Lattices", state), to: at("A paragraph", state), insert: "" },
        }),
      ],
      [
        "a label changed",
        (state) => ({ changes: { from: at("#thm:main", state) + 9, insert: "-result" } }),
      ],
      [
        "a reference changed to the new label",
        (state) => ({ changes: { from: at("@thm:main for", state) + 9, insert: "-result" } }),
      ],
      [
        "a div added at the end",
        (state) => ({
          changes: { from: state.doc.length, insert: "\n::: {.remark}\nA remark with $r$.\n:::\n" },
        }),
      ],
      [
        "two carets",
        (state) => ({
          selection: EditorSelection.create([
            EditorSelection.cursor(at("Up to isometry", state) + 2),
            EditorSelection.cursor(at("A remark", state) + 2),
          ]),
        }),
      ],
      [
        "two changes in one transaction",
        (state) => ({
          changes: [
            { from: at("An opening", state), insert: "X" },
            { from: at("A remark", state), insert: "Y" },
          ],
        }),
      ],
      [
        "the front matter deleted",
        (state) => ({
          changes: { from: 0, to: at("An opening", state), insert: "" },
          selection: { anchor: 0 },
        }),
      ],
      ["the caret at the end", (state) => ({ selection: { anchor: state.doc.length } })],
    ];

    const edited = createEditor(AGGREGATE_DOC, EditorSelection.single(AGGREGATE_DOC.length));
    assert.ok(drawn(edited).length > 20, "the renderers must draw the document");
    for (const [step, spec] of steps) {
      edited.dispatch(spec(edited.state));
      parsedView(edited);
      const fresh = createEditor(edited.state.sliceDoc(), edited.state.selection);
      assertSameDrawing(edited, fresh, step);
      fresh.destroy();
      views.pop();
    }
  });

  it("stay in place for a configuration update that changes no renderer setting", function () {
    const view = createEditor(AGGREGATE_DOC, EditorSelection.single(AGGREGATE_DOC.length));
    const before = drawn(view);
    const update = view.state.update({
      effects: configUpdateEffect.of({
        ...view.state.field(configField),
        renderMath: true,
        metadata: { ...getDefaultConfig().metadata },
      }),
    });
    assert.equal(update.reconfigured, false);
    view.dispatch(update);
    assert.ok(
      view.state.field(configField) === update.startState.field(configField),
      "the same values keep the configuration object",
    );
    const after = drawn(view);
    assert.equal(after.length, before.length);
    for (const [index, item] of after.entries()) {
      assert.ok(
        item.decoration === before[index].decoration,
        `${describeDrawn(view, item)} must be the object that the editor drew before`,
      );
    }
  });

  it("follow a configuration update that changes a renderer setting", function () {
    const view = createEditor(AGGREGATE_DOC, EditorSelection.single(AGGREGATE_DOC.length));
    assert.notEqual(view.dom.querySelector(".preview-math"), null);
    const update = view.state.update({
      effects: configUpdateEffect.of({ ...view.state.field(configField), renderMath: false }),
    });
    assert.equal(update.reconfigured, true);
    view.dispatch(update);
    assert.equal(view.dom.querySelector(".preview-math"), null);
    assert.ok(
      view.contentDOM.textContent.includes("A paragraph with x^2 and"),
      "the math shows as text",
    );
  });
});
