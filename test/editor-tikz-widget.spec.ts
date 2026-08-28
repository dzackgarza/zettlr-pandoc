/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ editor widget red proofs (issue #14)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the in-editor TikZ contract: a raw
 *                  \begin{tikzcd}/\begin{tikzpicture} block and a ```tikz
 *                  fence render as async figure widgets over the tikz-render
 *                  IPC seam; a cache-hit response lands as inline SVG; a
 *                  compile failure surfaces the mapped diagnostic in place;
 *                  missing tools are named; a toolchain check that failed for
 *                  a reason other than absence names the tool and the errno
 *                  rather than telling the user to install it; a render killed
 *                  by a signal names the signal; the request carries the
 *                  configured document
 *                  path; a success whose markup carries no figure is refused
 *                  rather than mounted; clicking a rendered figure requests
 *                  the lightbox with the servable SVG path; and the cursor
 *                  entering the block reveals raw source. The spec drives a
 *                  real EditorView with the production renderer and a
 *                  recorded IPC seam — no fabricated widget states.
 *
 * END HEADER
 */

import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  __resetTikzRenderMemoForTests,
  renderTikzFigures,
} from "source/common/modules/markdown-editor/renderers/render-tikz";
import {
  configField,
  type EditorConfiguration,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";

function polyfillJsdomForCodeMirror(): void {
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

const RAW_BLOCK = "\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}";
const FENCE_BODY = "\\documentclass[tikz]{standalone}\\begin{document}x\\end{document}";
const DOC = `Prose before keeps the caret away.\n\n${RAW_BLOCK}\n\n\`\`\`tikz\n${FENCE_BODY}\n\`\`\`\n\nProse after.\n`;

const SVG_OK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g id="abc12345-glyph0"><use xlink:href="#abc12345-glyph0"/></g></svg>';

/**
 * The markup pandoc's HTML writer actually produces for the filter's
 * Para(RawInline(html)): the figure's own <div> wrapped in a paragraph.
 */
const FIGURE_HTML = `<p><div style="text-align:center;"><span class="tikzcd">${SVG_OK}</span></div></p>`;

type SeamResponse = TikzRenderResult | ((request: TikzRenderRequest) => TikzRenderResult);

describe("TikZ editor widgets (issue #14)", function () {
  const views: EditorView[] = [];
  let invocations: Array<{ command: string; payload: TikzRenderRequest }> = [];
  let respond: SeamResponse;

  before(function () {
    polyfillJsdomForCodeMirror();
  });

  beforeEach(function () {
    __resetTikzRenderMemoForTests();
    invocations = [];
    (window as any).ipc = {
      invoke: async (channel: string, message: { command: string; payload: TikzRenderRequest }) => {
        invocations.push({ command: message.command, payload: message.payload });
        return typeof respond === "function" ? respond(message.payload) : respond;
      },
      on: () => () => {},
      send: () => {},
      sendSync: () => undefined,
    };
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function createEditor(anchor: number = 0, config?: EditorConfiguration): EditorView {
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor },
      extensions: [
        markdownParser(),
        config === undefined ? configField : configField.init(() => config),
        renderTikzFigures,
      ],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(
      forceParsing(view, DOC.length, 5000),
      "the syntax tree must be fully parsed before asserting",
    );
    views.push(view);
    return view;
  }

  async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    for (let round = 0; round < 200; round++) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  it("renders the raw block and the tikz fence as figure widgets over the IPC seam", async function () {
    respond = {
      ok: true,
      html: `<div style="text-align:center;"><span class="tikzcd">${SVG_OK}</span></div>`,
      svgPath: "/cache/lightbox-abc.svg",
    };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelectorAll(".tikz-figure svg").length === 2,
      "both figures to upgrade to SVG",
    );

    assert.strictEqual(invocations.length, 2, "each figure renders through one IPC request");
    const kinds = invocations.map((record) => record.payload.kind).sort();
    assert.deepStrictEqual(kinds, ["fence", "raw"]);
    const raw = invocations.find((record) => record.payload.kind === "raw");
    assert.strictEqual(raw?.payload.source, RAW_BLOCK, "the raw block is sent verbatim");
    const fence = invocations.find((record) => record.payload.kind === "fence");
    assert.strictEqual(
      fence?.payload.source,
      FENCE_BODY,
      "the fence body is sent without its fences",
    );
    assert.ok(
      !(view.dom.textContent ?? "").includes("\\begin{tikzcd}"),
      "the raw source is replaced by the widget",
    );
  });

  it("carries the document path from the editor configuration into every render request", async function () {
    // \input resolution depends on where the document lives, so the request
    // must report the configuration's path rather than any value of its own.
    respond = { ok: true, html: FIGURE_HTML, svgPath: "/cache/x.svg" };
    const config = getDefaultConfig();
    config.metadata.path = "/home/author/notes/coble-lattices.md";
    const view = createEditor(0, config);
    await waitFor(
      () => view.dom.querySelectorAll(".tikz-figure svg").length === 2,
      "both figures to upgrade to SVG",
    );

    const docPaths = invocations.map((record) => record.payload.docPath);
    assert.deepStrictEqual(
      docPaths,
      [config.metadata.path, config.metadata.path],
      "both figures are authored in the configured document",
    );
  });

  it("mounts the figure without pandoc paragraph wrapper the HTML writer adds", async function () {
    // The wrapper is why the widget extracts at all: mounting it leaves an
    // empty paragraph whose margins displace the figure.
    respond = { ok: true, html: FIGURE_HTML, svgPath: "/cache/x.svg" };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelectorAll(".tikz-figure svg").length === 2,
      "both figures to upgrade to SVG",
    );

    for (const figure of Array.from(view.dom.querySelectorAll<HTMLElement>(".tikz-figure"))) {
      assert.strictEqual(
        figure.querySelectorAll("p").length,
        0,
        "no paragraph wrapper survives into the mounted figure",
      );
      assert.ok(
        figure.querySelector("div > span.tikzcd > svg") !== null,
        "the figure's own element hierarchy is mounted intact",
      );
    }
  });

  it("refuses a success whose markup carries no figure instead of mounting it", async function () {
    // The service only reports success after confirming its pandoc output
    // carries an <svg>; markup without one means the two sides disagree about
    // what a successful render is. Mounting it anyway is what reintroduced the
    // paragraph defect this extraction exists to prevent.
    const bogus = "<p>the filter emitted no figure for this block</p>";
    respond = { ok: true, html: bogus, svgPath: "/cache/x.svg" };
    const view = createEditor();
    await waitFor(() => invocations.length === 2, "both figures to have been requested");
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const figure of Array.from(view.dom.querySelectorAll<HTMLElement>(".tikz-figure"))) {
      assert.ok(
        !(figure.textContent ?? "").includes("the filter emitted no figure"),
        "the non-conforming markup is not mounted",
      );
      assert.strictEqual(
        figure.dataset.tikzSvgPath,
        undefined,
        "no figure means no lightbox target",
      );
      assert.ok(
        figure.classList.contains("tikz-pending"),
        "the widget stays unrendered rather than presenting a figure it did not get",
      );
    }
  });

  it("names the signal when the render was killed, distinct from a pandoc diagnostic", async function () {
    respond = { ok: false, kind: "render-terminated", signal: "SIGKILL", log: "pdflatex ..." };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelector(".tikz-error") !== null,
      "the terminated-render box",
    );
    const text = view.dom.querySelector<HTMLElement>(".tikz-error")?.textContent ?? "";
    assert.ok(text.includes("SIGKILL"), `the signal that ended the render is shown: ${text}`);
    assert.ok(
      !text.toLowerCase().includes("pandoc error"),
      `a kill is not reported as a pandoc diagnostic: ${text}`,
    );
  });

  it("surfaces a mapped compile failure in place, never silence", async function () {
    respond = (request) =>
      request.kind === "raw"
        ? {
            ok: false,
            kind: "compile-error",
            errors: [
              {
                line: 2,
                message: "Undefined control sequence.",
                sourceLine: "A \\arrow[r] & B \\nope",
              },
            ],
            log: "",
          }
        : { ok: true, html: `<div><span>${SVG_OK}</span></div>`, svgPath: "/cache/x.svg" };
    const view = createEditor();
    await waitFor(() => view.dom.querySelector(".tikz-error") !== null, "the compile error box");

    const box = view.dom.querySelector<HTMLElement>(".tikz-error");
    const text = box?.textContent ?? "";
    assert.ok(text.includes("Undefined control sequence."), "the LaTeX message is shown");
    assert.ok(text.includes("2"), "the mapped figure-body line is shown");
    assert.ok(text.includes("A \\arrow[r] & B \\nope"), "the verbatim source line is shown");
  });

  it("names the missing tools when the toolchain is absent", async function () {
    respond = { ok: false, kind: "missing-tools", missing: ["pdflatex", "pdf2svg"] };
    const view = createEditor();
    await waitFor(() => view.dom.querySelector(".tikz-error") !== null, "the missing-tools box");
    const text = view.dom.querySelector<HTMLElement>(".tikz-error")?.textContent ?? "";
    assert.ok(
      text.includes("pdflatex") && text.includes("pdf2svg"),
      `both tools are named: ${text}`,
    );
  });

  it("names the tool and the errno when the toolchain check itself failed, instead of reporting absence", async function () {
    // EACCES, EPERM and EAGAIN are not "not installed". Presenting them as the
    // missing-tools case sends the user to install software they already have
    // and hides the permission or resource problem that actually stopped the
    // render.
    respond = { ok: false, kind: "toolchain-probe-failed", tool: "pdflatex", code: "EACCES" };
    const view = createEditor();
    await waitFor(() => view.dom.querySelector(".tikz-error") !== null, "the failed-probe box");
    const text = view.dom.querySelector<HTMLElement>(".tikz-error")?.textContent ?? "";
    assert.ok(text.includes("pdflatex"), `the tool whose check failed is named: ${text}`);
    assert.ok(text.includes("EACCES"), `the errno that ended the check is shown: ${text}`);
    assert.ok(
      !/not found|install/i.test(text),
      `a check that failed is not presented as an absent tool: ${text}`,
    );
  });

  it("requests the lightbox with the servable SVG path on click, built in the clicked document's own realm", async function () {
    respond = {
      ok: true,
      html: `<div><span>${SVG_OK}</span></div>`,
      svgPath: "/cache/lightbox-abc.svg",
    };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelectorAll(".tikz-figure svg").length === 2,
      "figures to upgrade",
    );

    const editorWindow = view.dom.ownerDocument.defaultView;
    if (editorWindow === null) {
      assert.fail("the widget is driven in a rendered document, which is what gives it a window");
    }

    const requests: Array<CustomEvent<{ svgPath: string }>> = [];
    const listener = (event: Event): void => {
      requests.push(event as CustomEvent<{ svgPath: string }>);
    };
    document.addEventListener("zettlr-tikz-lightbox", listener);
    try {
      view.dom
        .querySelector<HTMLElement>(".tikz-figure")
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      assert.deepStrictEqual(
        requests.map((request) => request.detail.svgPath),
        ["/cache/lightbox-abc.svg"],
        "one lightbox request carrying the SVG path",
      );
      // A document only accepts an event constructed by its own realm, so the
      // realm of the delivered request is what decides whether a click can
      // reach the lightbox at all: an event built from any other CustomEvent
      // constructor is refused by this document and no request arrives.
      assert.ok(
        requests[0] instanceof editorWindow.CustomEvent,
        "the request the document delivered was constructed by that document's own window",
      );
    } finally {
      document.removeEventListener("zettlr-tikz-lightbox", listener);
    }
  });

  it("reveals raw source while the selection is inside the block", function () {
    respond = { ok: true, html: `<div><span>${SVG_OK}</span></div>`, svgPath: "/cache/x.svg" };
    const view = createEditor(DOC.indexOf("tikzcd}") + 2);
    assert.ok(
      (view.dom.textContent ?? "").includes("\\begin{tikzcd}"),
      "the raw source shows for editing",
    );
  });
});
