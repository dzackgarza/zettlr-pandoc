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
 *                  configured document path; a success whose markup carries no
 *                  figure is refused rather than mounted; clicking rendered
 *                  any rendered TikZ/tikzcd click reveals its source so the
 *                  unified RHS preview owns renderer selection, while a separate expand control
 *                  requests the lightbox; and the cursor entering the block
 *                  reveals raw source. The spec drives a
 *                  real EditorView with the production renderer and a
 *                  recorded IPC seam — no fabricated widget states.
 *
 * END HEADER
 */

import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { collectTikzCompilerFindings } from "source/app/util/tikz-compiler-findings";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  __resetTikzRenderMemoForTests,
  renderTikzFigures,
} from "source/common/modules/markdown-editor/renderers/render-tikz";
import { activeTikzBlock } from "source/common/modules/markdown-editor/tikz-block";
import { requestTikzRender } from "source/common/modules/markdown-editor/tikz-render-client";
import {
  configField,
  type EditorConfiguration,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";

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
    class TestResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });
    if (typeof window === "object") {
      Object.defineProperty(window, "ResizeObserver", {
        configurable: true,
        value: TestResizeObserver,
        writable: true,
      });
    }
  }
  if (typeof Range !== "undefined" && typeof Range.prototype.getClientRects !== "function") {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      },
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

function isTikzRenderRequest(value: unknown): value is TikzRenderRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string" &&
    "docPath" in value &&
    typeof value.docPath === "string" &&
    "kind" in value &&
    (value.kind === "raw" || value.kind === "fence") &&
    "language" in value &&
    (value.language === "tikz" || value.language === "tikzcd")
  );
}

function installTikzInvoke(
  invoke: (request: TikzRenderRequest) => Promise<TikzRenderResult>,
): void {
  const invokeHandler = (async (channel: string, message: unknown) => {
    if (
      channel !== "application" ||
      typeof message !== "object" ||
      message === null ||
      !("command" in message) ||
      message.command !== "tikz-render" ||
      !("payload" in message) ||
      !isTikzRenderRequest(message.payload)
    ) {
      throw new Error(`unexpected IPC call in TikZ widget test: ${channel}`);
    }
    return await invoke(message.payload);
  }) as typeof window.ipc.invoke;

  Object.defineProperty(window, "ipc", {
    configurable: true,
    writable: true,
    value: {
      invoke: invokeHandler,
      on: () => () => {},
      send: () => {},
      sendSync: () => undefined,
    },
  });
}

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
    installTikzInvoke(async (request) => {
      invocations.push({ command: "tikz-render", payload: request });
      return typeof respond === "function" ? respond(request) : respond;
    });
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
      svg: SVG_OK,
      svgPath: "/cache/lightbox-abc.svg",
      texFontSizePt: 10,
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
    const figures = [...view.dom.querySelectorAll<HTMLElement>(".tikz-figure")];
    for (const figure of figures) {
      assert.ok(
        figure.classList.contains("tikz-rendered"),
        "a successful figure exposes the complete click-to-edit surface",
      );
    }
    assert.deepStrictEqual(
      figures.map((figure) => figure.title),
      ["Click to edit TikZ source", "Click to edit TikZ source"],
    );
  });

  it("renders a multiline raw tikzpicture inside a Pandoc div as one figure", async function () {
    respond = {
      ok: true,
      html: FIGURE_HTML,
      svg: SVG_OK,
      svgPath: "/cache/multiline.svg",
      texFontSizePt: 10,
    };
    const raw = [
      "\\begin{tikzpicture}",
      "",
      "\\coordinate (d1) at (0,0);",
      "",
      "\\draw (d1) -- ++(1,1);",
      "",
      "\\end{tikzpicture}",
    ].join("\n");
    const doc = ["::: {.example}", "Before.", "", raw, "", "After.", ":::", ""].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdownParser(), configField, renderTikzFigures],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(forceParsing(view, doc.length, 5000), "the multiline raw block must fully parse");
    views.push(view);

    await waitFor(
      () => invocations.length === 1 && view.dom.querySelectorAll(".tikz-figure svg").length === 1,
      "the complete raw environment to render as one SVG widget",
    );
    assert.strictEqual(invocations[0].payload.kind, "raw");
    assert.strictEqual(invocations[0].payload.language, "tikz");
    assert.strictEqual(invocations[0].payload.source, raw);
    assert.ok(
      !(view.dom.textContent ?? "").includes("\\begin{tikzpicture}"),
      "the entire raw environment is replaced rather than leaving paragraph fragments behind",
    );

    const editState = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("\\draw") + 2 },
      extensions: [markdownParser(), configField],
    });
    assert.strictEqual(
      activeTikzBlock(editState)?.source,
      raw,
      "live preview resolves the same complete raw block as the inline renderer",
    );
  });

  it("carries the document path from the editor configuration into every render request", async function () {
    // \input resolution depends on where the document lives, so the request
    // must report the configuration's path rather than any value of its own.
    respond = {
      ok: true,
      html: FIGURE_HTML,
      svg: SVG_OK,
      svgPath: "/cache/x.svg",
      texFontSizePt: 10,
    };
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

  it("does not deduplicate identical in-flight source across different document roots", async function () {
    let release!: (result: TikzRenderResult) => void;
    const pending = new Promise<TikzRenderResult>((resolve) => {
      release = resolve;
    });
    installTikzInvoke(async (request) => {
      invocations.push({ command: "tikz-render", payload: request });
      return await pending;
    });

    const firstConfig = getDefaultConfig();
    firstConfig.metadata.path = "/one/notes/diagram.md";
    const secondConfig = getDefaultConfig();
    secondConfig.metadata.path = "/two/notes/diagram.md";
    createEditor(0, firstConfig);
    createEditor(0, secondConfig);

    await waitFor(
      () => invocations.length === 4,
      "both figures in both document roots to issue their own requests",
    );
    assert.deepStrictEqual(
      invocations.map((record) => record.payload.docPath).sort(),
      [
        firstConfig.metadata.path,
        firstConfig.metadata.path,
        secondConfig.metadata.path,
        secondConfig.metadata.path,
      ].sort(),
    );
    release({
      ok: true,
      html: FIGURE_HTML,
      svg: SVG_OK,
      svgPath: "/cache/x.svg",
      texFontSizePt: 10,
    });
    await waitFor(
      () => document.querySelectorAll(".tikz-figure svg").length === 4,
      "all four figures to settle",
    );
  });

  it("mounts the figure without pandoc paragraph wrapper the HTML writer adds", async function () {
    // The wrapper is why the widget extracts at all: mounting it leaves an
    // empty paragraph whose margins displace the figure.
    respond = {
      ok: true,
      html: FIGURE_HTML,
      svg: SVG_OK,
      svgPath: "/cache/x.svg",
      texFontSizePt: 10,
    };
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

  it("preserves the TeX/pdf2svg natural box instead of promoting diagrams to semantic width buckets", async function () {
    const compactSvg =
      '<svg width="72.842pt" height="59.074pt" viewBox="0 0 72.842 59.074"><use href="#g"/></svg>';
    const denseSvg = `<svg width="227.619pt" height="135.986pt" viewBox="0 0 227.619 135.986">${'<use href="#g"/>'.repeat(150)}</svg>`;
    respond = (request) =>
      request.kind === "raw"
        ? {
            ok: true,
            html: `<div>${compactSvg}</div>`,
            svg: compactSvg,
            svgPath: "/cache/compact.svg",
            texFontSizePt: 10,
          }
        : {
            ok: true,
            html: `<div>${denseSvg}</div>`,
            svg: denseSvg,
            svgPath: "/cache/dense.svg",
            texFontSizePt: 10,
          };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelectorAll(".tikz-figure svg").length === 2,
      "both naturally sized figures",
    );

    const figures = Array.from(view.dom.querySelectorAll<HTMLElement>(".tikz-figure"));
    assert.deepStrictEqual(
      figures.map((figure) => figure.querySelector("svg")?.getAttribute("width")).sort(),
      ["227.619pt", "72.842pt"].sort(),
      "the renderer keeps the physical widths emitted by TeX/pdf2svg",
    );
    const normalizedWidths = figures
      .map((figure) =>
        Number.parseFloat(
          figure.querySelector<HTMLElement>(".tikz-rendered-frame")?.style.width ?? "NaN",
        ),
      )
      .sort((a, b) => a - b);
    assert.ok(Math.abs(normalizedWidths[0] - 8.01262) < 0.001);
    assert.ok(Math.abs(normalizedWidths[1] - 25.03809) < 0.001);
    assert.ok(figures.every((figure) => figure.dataset.tikzTexFontSizePt === "10"));
    assert.ok(
      figures.every(
        (figure) =>
          !Array.from(figure.classList).some((className) => className.startsWith("tikz-size-")),
      ),
      "no content-density class is allowed to enlarge the natural figure box",
    );
    assert.ok(
      figures.every((figure) => figure.querySelector(".tikz-expand-button") === null),
      "inline figures expose no competing fullscreen affordance; expansion belongs to the RHS preview",
    );
  });

  it("refuses a success whose markup carries no figure instead of mounting it", async function () {
    // The service only reports success after confirming its pandoc output
    // carries an <svg>; markup without one means the two sides disagree about
    // what a successful render is. Mounting it anyway is what reintroduced the
    // paragraph defect this extraction exists to prevent.
    const bogus = "<p>the filter emitted no figure for this block</p>";
    respond = { ok: true, html: bogus, svg: SVG_OK, svgPath: "/cache/x.svg", texFontSizePt: 10 };
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
        : {
            ok: true,
            html: `<div><span>${SVG_OK}</span></div>`,
            svg: SVG_OK,
            svgPath: "/cache/x.svg",
            texFontSizePt: 10,
          };
    const view = createEditor();
    await waitFor(() => view.dom.querySelector(".tikz-error") !== null, "the compile error box");

    const box = view.dom.querySelector<HTMLElement>(".tikz-error");
    const text = box?.textContent ?? "";
    assert.ok(text.includes("Undefined control sequence."), "the LaTeX message is shown");
    assert.ok(text.includes("2"), "the mapped figure-body line is shown");
    assert.ok(text.includes("A \\arrow[r] & B \\nope"), "the verbatim source line is shown");
    const failedFigure = box?.closest<HTMLElement>(".tikz-figure");
    assert.ok(failedFigure !== null && failedFigure !== undefined);
    assert.ok(
      !failedFigure.classList.contains("tikz-rendered"),
      "compile diagnostics do not inherit the successful edit-target surface",
    );
  });

  it("maps a failed TikZ compilation to standalone compiler context for Flowmark", async function () {
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
            log: "! Undefined control sequence.\n",
          }
        : {
            ok: true,
            html: `<div><span>${SVG_OK}</span></div>`,
            svg: SVG_OK,
            svgPath: "/cache/x.svg",
            texFontSizePt: 10,
          };
    const view = createEditor();
    const diagnostics = await collectTikzCompilerFindings(
      view.state.doc.toString(),
      view.state.field(configField).metadata.path,
      requestTikzRender,
    );
    const compile = diagnostics[0];
    assert.ok(compile !== undefined);
    assert.match(compile.message, /Undefined control sequence/u);
    assert.equal(view.state.doc.lineAt(compile.from).number, 4);
  });

  it("surfaces the real compiler log when a compile failure has no mapped source-line diagnostic", async function () {
    const compilerLog = [
      "This is pdfTeX, Version 3.141592653",
      "! Package pgf Error: No shape named `missing-node` is known.",
      "See the pgf package documentation for explanation.",
      "l.17 \\draw (missing-node) -- (0,0);",
      "Fatal error occurred, no output PDF file produced!",
    ].join("\n");
    respond = (request) =>
      request.kind === "raw"
        ? { ok: false, kind: "compile-error", errors: [], log: compilerLog }
        : {
            ok: true,
            html: `<div><span>${SVG_OK}</span></div>`,
            svg: SVG_OK,
            svgPath: "/cache/x.svg",
            texFontSizePt: 10,
          };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelector(".tikz-error") !== null,
      "the compiler-log error box",
    );

    const text = view.dom.querySelector<HTMLElement>(".tikz-error")?.textContent ?? "";
    assert.ok(
      text.includes("No shape named `missing-node` is known."),
      `the actual compiler error is visible: ${text}`,
    );
    assert.ok(
      text.includes("\\draw (missing-node) -- (0,0);"),
      `the compiler-cited source is visible: ${text}`,
    );
    assert.ok(
      !/no diagnostic|see the render log/i.test(text),
      `the real log must never be replaced by a canned redirect: ${text}`,
    );
  });

  it("keeps compile diagnostics selectable instead of turning clicks into source-edit activation", async function () {
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
            log: "! Undefined control sequence.\nl.2 A \\arrow[r] & B \\nope\n",
          }
        : {
            ok: true,
            html: `<div><span>${SVG_OK}</span></div>`,
            svg: SVG_OK,
            svgPath: "/cache/x.svg",
            texFontSizePt: 10,
          };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelector(".tikz-error") !== null,
      "the selectable compile error box",
    );

    const box = view.dom.querySelector<HTMLElement>(".tikz-error");
    assert.ok(box !== null);
    const source = box.querySelector("code");
    assert.ok(source !== null);
    const selectionBefore = view.state.selection.main;
    const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    const dispatched = source.dispatchEvent(click);

    assert.equal(dispatched, true, "diagnostic clicks are not consumed by edit activation");
    assert.equal(click.defaultPrevented, false);
    assert.equal(view.state.selection.main.from, selectionBefore.from);
    assert.equal(view.state.selection.main.to, selectionBefore.to);
    assert.equal(getComputedStyle(box).userSelect, "text");
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

  it("uses edit-first source activation for both tikzcd and ordinary TikZ", async function () {
    respond = {
      ok: true,
      html: `<div><span>${SVG_OK}</span></div>`,
      svg: SVG_OK,
      svgPath: "/cache/edit-first.svg",
      texFontSizePt: 10,
    };
    const view = createEditor();
    await waitFor(
      () => view.dom.querySelectorAll(".tikz-figure svg").length === 2,
      "figures to upgrade",
    );

    const figures = view.dom.querySelectorAll<HTMLElement>(".tikz-figure svg");
    figures[0]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const rawFrom = DOC.indexOf(RAW_BLOCK);
    assert.ok(
      view.state.selection.ranges.some(
        (range) => range.from <= rawFrom && range.to >= rawFrom + RAW_BLOCK.length,
      ),
      "tikzcd selects its authored source range so the RHS preview owns TikZ/Quiver mode selection",
    );
    figures[1]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const fenceFrom = DOC.indexOf("```tikz");
    const fenceTo = DOC.indexOf("```", fenceFrom + "```tikz".length) + 3;
    assert.ok(
      view.state.selection.ranges.some((range) => range.from <= fenceFrom && range.to >= fenceTo),
      "ordinary TikZ selects its authored source range through the same activation path",
    );
    assert.ok(
      (view.dom.textContent ?? "").includes(FENCE_BODY),
      "ordinary TikZ selection reveals its source for editing",
    );
  });

  it("reveals raw source while the selection is inside the block", function () {
    respond = {
      ok: true,
      html: `<div><span>${SVG_OK}</span></div>`,
      svg: SVG_OK,
      svgPath: "/cache/x.svg",
      texFontSizePt: 10,
    };
    const view = createEditor(DOC.indexOf("tikzcd}") + 2);
    assert.ok(
      (view.dom.textContent ?? "").includes("\\begin{tikzcd}"),
      "the raw source shows for editing",
    );
  });

  it("derives the live-preview source from the same raw/fence recognition as the inline renderer", function () {
    respond = {
      ok: true,
      html: `<div><span>${SVG_OK}</span></div>`,
      svg: SVG_OK,
      svgPath: "/cache/x.svg",
      texFontSizePt: 10,
    };

    const rawView = createEditor(DOC.indexOf("arrow[r]") + 3);
    const raw = activeTikzBlock(rawView.state);
    assert.deepStrictEqual(
      raw === null ? null : { kind: raw.kind, language: raw.language, source: raw.source },
      { kind: "raw", language: "tikzcd", source: RAW_BLOCK },
      "nested Markdown syntax inside a raw TikZ paragraph still resolves to the whole figure source",
    );

    const selectedRawState = EditorState.create({
      doc: DOC,
      selection: {
        anchor: DOC.indexOf(RAW_BLOCK),
        head: DOC.indexOf(RAW_BLOCK) + RAW_BLOCK.length,
      },
      extensions: [markdownParser(), configField],
    });
    assert.strictEqual(
      activeTikzBlock(selectedRawState)?.source,
      RAW_BLOCK,
      "selecting the whole rendered source range still counts as editing that TikZ block for the sidecar",
    );

    const standaloneFenceView = createEditor(DOC.indexOf(FENCE_BODY) + 5);
    assert.strictEqual(
      activeTikzBlock(standaloneFenceView.state),
      null,
      "a fenced full LaTeX document keeps its own preamble and is not misrepresented as an owned-template live preview",
    );

    const snippet = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}";
    const snippetDoc = `before\n\n\`\`\`tikz\n${snippet}\n\`\`\`\nafter\n`;
    const snippetState = EditorState.create({
      doc: snippetDoc,
      selection: { anchor: snippetDoc.indexOf("draw") + 2 },
      extensions: [markdownParser(), configField],
    });
    const fence = activeTikzBlock(snippetState);
    assert.deepStrictEqual(
      fence === null ? null : { kind: fence.kind, language: fence.language, source: fence.source },
      { kind: "fence", language: "tikz", source: snippet },
      "a snippet fence resolves to the body without its Markdown fences and remains template-owned",
    );

    const tikzCdBody = 'A \\arrow[r, "f"] & B';
    const tikzCdDoc = `before\n\n\`\`\`tikzcd\n${tikzCdBody}\n\`\`\`\nafter\n`;
    const tikzCdState = EditorState.create({
      doc: tikzCdDoc,
      selection: { anchor: tikzCdDoc.indexOf("arrow") + 2 },
      extensions: [markdownParser(), configField],
    });
    const tikzCdFence = activeTikzBlock(tikzCdState);
    assert.deepStrictEqual(
      tikzCdFence === null
        ? null
        : { kind: tikzCdFence.kind, language: tikzCdFence.language, source: tikzCdFence.source },
      { kind: "fence", language: "tikzcd", source: tikzCdBody },
      "a tikzcd fence is a first-class template-owned figure rather than only a highlighted code block",
    );

    const proseView = createEditor(2);
    assert.strictEqual(
      activeTikzBlock(proseView.state),
      null,
      "ordinary prose does not open a TikZ live preview",
    );
  });

  it("renders a standalone \\input with a .tikz or .tikzcd extension as a raw figure widget", async function () {
    respond = {
      ok: true,
      html: `<div style="text-align:center;"><span class="tikzpic">${SVG_OK}</span></div>`,
      svg: SVG_OK,
      svgPath: "/cache/sterk.svg",
      texFontSizePt: 10,
    };
    const inputDoc =
      "Prose before.\n\n\\input{tikz/sterk-cusp-diagram.tikz}\n\n\\input{figures/comm-square.tikzcd}\n\n\\input{chapters/intro.tex}\n\nProse after.\n";
    const state = EditorState.create({
      doc: inputDoc,
      selection: { anchor: 0 },
      extensions: [markdownParser(), configField, renderTikzFigures],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(
      forceParsing(view, inputDoc.length, 5000),
      "the syntax tree must be fully parsed before asserting",
    );
    views.push(view);

    await waitFor(
      () => invocations.length === 2,
      "both .tikz and .tikzcd inputs to issue render requests",
    );

    assert.strictEqual(
      invocations.length,
      2,
      "only the .tikz and .tikzcd inputs trigger requests, ignoring .tex",
    );
    const tikzInv = invocations.find((inv) =>
      inv.payload.source.includes("sterk-cusp-diagram.tikz"),
    );
    assert.ok(tikzInv !== undefined);
    assert.strictEqual(tikzInv.payload.kind, "raw");
    assert.strictEqual(tikzInv.payload.language, "tikz");
    assert.strictEqual(tikzInv.payload.source, "\\input{tikz/sterk-cusp-diagram.tikz}");

    const tikzcdInv = invocations.find((inv) => inv.payload.source.includes("comm-square.tikzcd"));
    assert.ok(tikzcdInv !== undefined);
    assert.strictEqual(tikzcdInv.payload.kind, "raw");
    assert.strictEqual(tikzcdInv.payload.language, "tikzcd");
    assert.strictEqual(tikzcdInv.payload.source, "\\input{figures/comm-square.tikzcd}");

    const tikzBlock = activeTikzBlock(
      EditorState.create({
        doc: inputDoc,
        selection: { anchor: inputDoc.indexOf("sterk-cusp-diagram") },
        extensions: [markdownParser(), configField],
      }),
    );
    assert.deepStrictEqual(
      tikzBlock === null
        ? null
        : { kind: tikzBlock.kind, language: tikzBlock.language, source: tikzBlock.source },
      { kind: "raw", language: "tikz", source: "\\input{tikz/sterk-cusp-diagram.tikz}" },
    );

    const nonTikzBlock = activeTikzBlock(
      EditorState.create({
        doc: inputDoc,
        selection: { anchor: inputDoc.indexOf("chapters/intro.tex") },
        extensions: [markdownParser(), configField],
      }),
    );
    assert.strictEqual(nonTikzBlock, null, "ordinary .tex \\input is not treated as a TikZ block");
  });
});
