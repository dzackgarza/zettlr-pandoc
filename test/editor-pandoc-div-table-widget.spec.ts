/**
 * RED proof for issue #97: a pipe table nested inside a `::: {#...}` PandocDiv
 * never mounts the table editor widget; its raw pipe lines leak as text.
 *
 * The expected contract (measured by test/zz-redprobe-div-table.ts on the
 * current code):
 *   - TableWidget.createForState returns exactly 2 decoration ranges (one for
 *     the div-nested table, one for the control table)   [currently 1 → RED]
 *   - the DOM mounts both tables                          [currently 1 → RED]
 *   - no raw pipe lines leak through                      [currently 6 → RED]
 *
 * The probe found both Table syntax nodes carry a TableDelimiter child, so
 * parseTableNode succeeds on both; the sole blocker is the direct-children-only
 * Table discovery in TableWidget.createForState (widget.ts:266).
 */

import "./provision-renderer-window-seams";
// Initialize the renderer/table-editor module graph in the app's order before
// importing anything named, so the renderers -> table-editor -> subview cycle
// resolves (webpack tolerates it; a bare tsx import of subview first hits a
// temporal-dead-zone on subviewUpdatePlugin).
import "source/common/modules/markdown-editor/renderers";
import { strict as assert } from "assert";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  configField,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";
import { renderEmphasis } from "source/common/modules/markdown-editor/renderers/render-emphasis";
import { renderMath } from "source/common/modules/markdown-editor/renderers/render-math";
import { renderPandoc } from "source/common/modules/markdown-editor/renderers/render-pandoc-div-span";
import { renderTables } from "source/common/modules/markdown-editor/table-editor";
import { TableWidget } from "source/common/modules/markdown-editor/table-editor/widget";
import { initializeMathJax } from "source/common/util/mathtex-to-html";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";

function polyfillJsdomForCodeMirror(): void {
  const w = globalThis as any;
  if (typeof w.requestAnimationFrame !== "function") {
    w.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0);
    w.cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  if (
    typeof w.window === "object" &&
    typeof w.window.requestAnimationFrame !== "function"
  ) {
    w.window.requestAnimationFrame = w.requestAnimationFrame;
    w.window.cancelAnimationFrame = w.cancelAnimationFrame;
  }
  if (typeof w.ResizeObserver !== "function") {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    if (typeof w.window === "object") {
      w.window.ResizeObserver = w.ResizeObserver;
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== "function") {
    w.Range.prototype.getClientRects = () => [];
    w.Range.prototype.getBoundingClientRect = () => ({
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

// Verbatim: test/editor-table-math-visual-entry.ts (the capture-entry
// fragments, byte-for-byte, including template-literal escapes).
const grothendieckDiv = `::: {#def-grothendieck-topology-generalization}
## Generalization by Grothendieck topology

The formulation of @def-smooth-manifold and @def-scheme-as-lrs admits a uniform generalization.
Fix a category $\\mathcal{C}$ of locally ringed spaces, a class $\\mathscr{L}$ of local models, and a class $\\mathscr{A}$ of admissible morphisms.
A *$\\mathscr{A}$-atlas* for $X \\in \\mathcal{C}$ is an effective epimorphism $p\\colon \\coprod_{i \\in I} L_i \\to X$ with each $L_i \\in \\mathscr{L}$ and each component an $\\mathscr{A}$-morphism.
Different choices of $\\mathscr{A}$ yield different Grothendieck topologies and geometric objects:

| Admissible morphisms $\\mathscr{A}$ | Topology | Geometric objects |
|---|---|---|
| Open immersions | Zariski | Schemes |
| Étale morphisms | Étale | Algebraic spaces, Deligne–Mumford stacks |
| Faithfully flat morphisms of finite presentation | fppf | Artin stacks |
| Faithfully flat quasi-compact morphisms | fpqc | fpqc sheaves |

The smooth manifold case uses $\\mathscr{L} = \\{M_n\\}_{n \\geq 0}$ and $\\mathscr{A} =$ open immersions in $\\mathsf{LRS}_{\\mathbb{R}}$.
:::`;

const controlTable = `| Lattice | Signature |
|---------|-----------|
| $U$     | $(1,1)$   |
| $E_{8}$ | $(8,0)$   |`;

const doc = `${grothendieckDiv}

${controlTable}

The control rows above must render as a formed table, and the div-wrapped table must not leak raw pipe lines.`;

async function settleDom(view: EditorView): Promise<number> {
  let mounted = 0;
  for (let round = 0; round < 60; round++) {
    mounted = document.querySelectorAll(".cm-content table").length;
    if (mounted >= 2) {
      return mounted;
    }
    view.dispatch({});
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  return mounted;
}

describe("issue #97: pipe table nested in a PandocDiv mounts the table widget", function () {
  const views: EditorView[] = [];

  before(async function () {
    // initializeMathJax measured ~47974ms standalone under tsx in jsdom
    // (test/zz-time-mathjax-init.ts): tsx defers the MathJax module-graph
    // evaluation into the first call, so the ~48s is hook-internal. The cost
    // is load-variable (one probe finished in ~31s; a 60s-hook run timed
    // out). No network: mathjax.asyncLoad is stubbed to Promise.resolve in
    // mathtex-to-html.ts:61. The full-suite gate runs 120s, so this per-hook
    // override matches that budget (the suite's own ceiling).
    this.timeout(120000);
    polyfillJsdomForCodeMirror();
    await initializeMathJax(
      await loadMathJaxMacros("test/fixtures/mathjax-macros.json"),
    );
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function createView(): EditorView {
    const config = getDefaultConfig();
    config.renderingMode = "preview";
    config.renderMath = true;
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdownParser(),
        configField.init(() => config),
        renderPandoc,
        renderEmphasis,
        renderMath,
        renderTables,
      ],
    });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    assert.ok(
      forceParsing(view, doc.length, 5000),
      "the main syntax tree must be fully parsed",
    );
    view.focus();
    return view;
  }

  it("creates a table-widget decoration for the div-nested table and the control table", function () {
    const view = createView();
    // Exactly 2: the div-nested pipe table (issue #97) and the control table.
    // Currently 1 — direct-children-only Table discovery misses the div-nested
    // table (widget.ts:266).
    assert.strictEqual(TableWidget.createForState(view.state).size, 2);
  });

  it("renders both tables in the DOM and leaks no raw pipe lines", async function () {
    const view = createView();
    const mounted = await settleDom(view);

    const tables = Array.from(document.querySelectorAll(".cm-content table"));
    assert.strictEqual(
      mounted,
      2,
      "both the div-nested table and the control table must mount",
    );
    assert.strictEqual(tables.length, 2);

    // Document order: the div-nested table precedes the control table.
    assert.match(
      tables[0]?.textContent ?? "",
      /Admissible morphisms/,
      "the div-nested table must render its cells, not its raw pipe lines",
    );
    assert.match(
      tables[1]?.textContent ?? "",
      /Lattice/,
      "the control table must render as a formed table",
    );

    const rawPipeLines = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-line"),
    ).filter((line) => (line.textContent ?? "").trimStart().startsWith("|"));
    assert.deepStrictEqual(
      rawPipeLines.map((line) => line.textContent),
      [],
      "no raw pipe line may leak through the PandocDiv (currently 6)",
    );
  });
});
