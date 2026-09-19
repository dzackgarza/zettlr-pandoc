/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzRenderer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Renders TikZ figures inline (issue #14): raw
 *                  \begin{tikzcd}/\begin{tikzpicture} blocks and ```tikz/```tikzcd
 *                  code fences become async figure widgets. Compilation
 *                  happens in the main process (pdflatex + pdf2svg behind
 *                  the shared Pandoc filter's content-addressed cache),
 *                  so rendering never blocks typing; a cache hit lands
 *                  immediately. A figure that fails to compile shows the
 *                  filter's LaTeX bang-error diagnostic mapped to the tikz
 *                  source line; a machine without the toolchain names the
 *                  missing tools; a toolchain check that failed for a reason
 *                  other than absence names the tool and the errno instead of
 *                  telling the user to install it; a render killed by a signal
 *                  names the signal. Clicking a rendered figure follows the
 *                  editor's ordinary edit-first semantics and reveals its
 *                  source; a separate corner control opens the full-screen
 *                  lightbox with the servable SVG file.
 *
 * END HEADER
 */

import { type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { reportError } from "@common/util/error-reporting";
import { tikzCompilerLogExcerpt } from "@common/util/tikz-compiler-log";
import { type SyntaxNodeRef } from "@lezer/common";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";
import type { TikzSourceBlock } from "../tikz-block";
import { tikzBlockForNode } from "../tikz-block";
import { tikzWidthEm } from "../tikz-display-size";
import { configField } from "../util/configuration";
import { renderBlockWidgets } from "./base-renderer";

/**
 * One in-flight render per figure source. Settled requests are removed: the
 * main process/filter own the durable content-addressed cache, and keeping a
 * second settled cache here would make the live preview's explicit Force
 * rerender invisible when the caret later leaves the block and this inline
 * widget returns.
 */
let renderMemo = new Map<string, Promise<TikzRenderResult>>();

/** Test seam: clears the session memo so seam stubs see every request. */
export function __resetTikzRenderMemoForTests(): void {
  renderMemo = new Map();
}

function requestRender(request: TikzRenderRequest): Promise<TikzRenderResult> {
  // docPath is semantically part of the render: relative \input{…} resolves
  // from it. Two panes with byte-identical source but different document
  // roots therefore must never share even an in-flight request.
  const key = `${request.kind}\0${request.language}\0${request.docPath}\0${request.source}`;
  const memoized = renderMemo.get(key);
  if (memoized !== undefined) {
    return memoized;
  }
  const pending: Promise<TikzRenderResult> = window.ipc.invoke("application", {
    command: "tikz-render",
    payload: request,
  });
  renderMemo.set(key, pending);
  const clear = (): void => {
    if (renderMemo.get(key) === pending) {
      renderMemo.delete(key);
    }
  };
  // Both handlers return void, so this cleanup chain resolves even when the
  // IPC promise rejects; using .finally() here would create a second rejected
  // promise with nobody to observe it.
  void pending.then(clear, clear);
  return pending;
}

/**
 * Turns the render service's figure markup into the nodes to mount.
 *
 * The filter emits the figure as Para(RawInline(html)), so pandoc's HTML
 * writer wraps it in a <p>; the browser splits <p><div> and leaves a stray
 * empty paragraph whose margins push the figure around. Unwrapping every
 * paragraph into its own children removes that wrapper for good: the
 * transformation is total, so there is no "could not find the figure" case for
 * the mount to fall back from.
 */
function figureNodes(html: string): Node[] {
  const template = document.createElement("template");
  template.innerHTML = html;

  // An ok result is only issued after the service confirmed the pandoc output
  // carries an <svg>…</svg>; markup without one means service and widget
  // disagree about what a successful render is, which no presentation can
  // repair.
  if (template.content.querySelector("svg") === null) {
    throw new Error(
      "render-tikz: the render service reported a successful figure whose markup carries no <svg> element. " +
        `Markup received (${html.length} chars): ${html.slice(0, 200)}. ` +
        "renderTikz in source/app/util/tikz-render.ts only returns ok after matching <svg>…</svg> in the " +
        "pandoc output, so either that check or this widget must change.",
    );
  }

  const nodes: Node[] = [];
  for (const child of Array.from(template.content.childNodes)) {
    if (child instanceof HTMLParagraphElement) {
      nodes.push(...Array.from(child.childNodes));
    } else {
      nodes.push(child);
    }
  }
  return nodes;
}

function normalizeSvgTypography(
  frame: HTMLElement,
  svgMarkup: string,
  texFontSizePt: number,
): void {
  const svg = frame.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) {
    return;
  }
  const widthEm = tikzWidthEm(svgMarkup, texFontSizePt);
  if (widthEm === null) {
    return;
  }

  // pdf2svg records the TeX page box in points. Express that width in editor
  // ems instead of CSS points: a 10pt TeX label then lands at one editor em,
  // matching body-math scale while preserving every relative distance chosen
  // by TikZ. This is uniform typography normalization, never density-based
  // enlargement; max-width below still shrinks genuinely oversized diagrams.
  frame.style.width = `${widthEm}em`;
  svg.style.width = "100%";
}

function populate(elem: HTMLElement, result: TikzRenderResult, editTitle: string): void {
  if (result.ok) {
    const figure = figureNodes(result.html);
    const frame = document.createElement("div");
    frame.classList.add("tikz-rendered-frame");
    frame.append(...figure);
    normalizeSvgTypography(frame, result.svg, result.texFontSizePt);

    // Editing is the only inline action. Fullscreen belongs to the unified
    // RHS preview pane so rendered widgets do not expose a second preview path.

    elem.classList.remove("tikz-pending");
    elem.classList.add("tikz-rendered");
    elem.title = editTitle;
    elem.replaceChildren(frame);
    elem.dataset.tikzSvgPath = result.svgPath;
    elem.dataset.tikzTexFontSizePt = String(result.texFontSizePt);
    return;
  }

  elem.classList.remove("tikz-pending", "tikz-rendered");
  elem.removeAttribute("title");
  delete elem.dataset.tikzSvgPath;
  delete elem.dataset.tikzTexFontSizePt;
  const box = document.createElement("div");
  box.classList.add("tikz-error");
  const title = document.createElement("strong");
  box.appendChild(title);

  switch (result.kind) {
    case "missing-tools":
      title.textContent = `TikZ rendering requires tools that were not found: ${result.missing.join(", ")}`;
      break;
    case "toolchain-probe-failed":
      // Deliberately not "install this tool": the tool may well be installed.
      // The errno is the whole diagnosis — EACCES is a permission bit, EAGAIN
      // is resource exhaustion — and telling the user to install something
      // instead would send them after the wrong problem.
      title.textContent = `TikZ could not check whether ${result.tool} is usable: the check failed with ${result.code}`;
      break;
    case "compile-error": {
      title.textContent = "TikZ figure failed to compile";
      for (const error of result.errors) {
        const line = document.createElement("div");
        const where = document.createElement("span");
        where.textContent = `line ${error.line}: ${error.message} `;
        const source = document.createElement("code");
        source.textContent = error.sourceLine;
        line.appendChild(where);
        line.appendChild(source);
        box.appendChild(line);
      }
      const compilerLog = tikzCompilerLogExcerpt(result.log, 24);
      if (result.errors.length === 0) {
        if (compilerLog !== "") {
          const log = document.createElement("pre");
          log.classList.add("tikz-compiler-log");
          log.textContent = compilerLog;
          box.appendChild(log);
        } else {
          const note = document.createElement("div");
          note.textContent = "TikZ compilation failed without any compiler output.";
          box.appendChild(note);
        }
      } else if (compilerLog !== "") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Compiler log";
        const log = document.createElement("pre");
        log.classList.add("tikz-compiler-log");
        log.textContent = compilerLog;
        details.append(summary, log);
        box.appendChild(details);
      }
      break;
    }
    case "pandoc-error": {
      title.textContent = "TikZ render failed (pandoc error)";
      const log = document.createElement("pre");
      log.textContent = result.log.split("\n").slice(-8).join("\n");
      box.appendChild(log);
      break;
    }
    case "render-terminated": {
      // Naming the signal is the point: a killed render is not pandoc
      // reporting anything about the figure, and the user needs to know the
      // difference to act on it.
      title.textContent = `TikZ render was killed by ${result.signal} before it finished`;
      const log = document.createElement("pre");
      log.textContent = result.log.split("\n").slice(-8).join("\n");
      box.appendChild(log);
      break;
    }
    default: {
      const unhandled: never = result;
      throw new Error(
        `render-tikz: unhandled TikzRenderResult case ${JSON.stringify(unhandled)}. ` +
          "The union lives in source/app/util/tikz-render.ts; every case it declares must be presented here.",
      );
    }
  }

  elem.replaceChildren(box);
}

class TikzWidget extends WidgetType {
  constructor(readonly block: TikzSourceBlock) {
    super();
  }

  eq(other: TikzWidget): boolean {
    // Widget event handlers close over the authored source range. A change in
    // any preceding block can shift an otherwise byte-identical figure, so
    // range movement is semantically observable and must rebuild the widget.
    return (
      other.block.source === this.block.source &&
      other.block.kind === this.block.kind &&
      other.block.language === this.block.language &&
      other.block.from === this.block.from &&
      other.block.to === this.block.to &&
      other.block.sourceFrom === this.block.sourceFrom &&
      other.block.sourceTo === this.block.sourceTo
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const elem = document.createElement("div");
    elem.classList.add("tikz-figure", "tikz-pending");
    elem.dataset.tikzLanguage = this.block.language;
    elem.dataset.tikzKind = this.block.kind;
    elem.textContent = "Rendering TikZ figure…";

    // The configuration carries the buffer's path, using the empty string for
    // a buffer that has none — the same value the request field is declared
    // against. This renderer is only ever installed alongside configField, so
    // its absence is a wiring defect and reads as one.
    const docPath = view.state.field(configField).metadata.path;
    const editTitle = "Click to edit TikZ source";
    requestRender({
      source: this.block.source,
      kind: this.block.kind,
      language: this.block.language,
      docPath,
    }).then(
      (result) => {
        populate(elem, result, editTitle);
      },
      // Only the IPC round-trip is handled here. A failure to reach the main
      // process is a render failure the user must see; a failure raised by
      // populate is a broken service/widget contract and must not be dressed
      // up as one of the render service's outcomes.
      (err: unknown) => {
        reportError("TikZ inline render IPC failed", err);
        populate(
          elem,
          {
            ok: false,
            kind: "pandoc-error",
            log: err instanceof Error ? err.message : String(err),
          },
          editTitle,
        );
      },
    );

    // Every rendered TikZ figure now has one edit-first activation path:
    // select its authored source and let the unified RHS preview choose the
    // appropriate renderer. tikzcd defaults to Quiver there; ordinary TikZ is
    // locked to the vanilla renderer.
    elem.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      view.dispatch({ selection: { anchor: this.block.from, head: this.block.to } });
    });
    return elem;
  }

  updateDOM(_dom: HTMLElement, _view: EditorView): boolean {
    return false; // Source changed: rebuild and re-render.
  }

  ignoreEvent(_event: Event): boolean {
    return true; // The widget owns edit activation and its explicit expand control.
  }
}

function shouldHandleNode(node: SyntaxNodeRef): boolean {
  return node.type.name === "Paragraph" || node.type.name === "FencedCode";
}

function createWidget(state: EditorState, node: SyntaxNodeRef): TikzWidget | undefined {
  const block = tikzBlockForNode(state, node);
  return block === undefined ? undefined : new TikzWidget(block);
}

export const renderTikzFigures = [
  renderBlockWidgets(["Paragraph", "FencedCode"], shouldHandleNode, createWidget),
  EditorView.baseTheme({
    ".tikz-figure": {
      display: "block",
      textAlign: "center",
      padding: "0.8em 0 0.4em",
      cursor: "default",
    },
    ".tikz-figure.tikz-rendered": {
      // Rendered Pandoc divs use a low-opacity semantic surface plus an
      // accent edge. TikZ is not a semantic container, so keep the same visual
      // vocabulary at much lower contrast: just enough to show the complete
      // click-to-edit target without turning every diagram into a card.
      boxSizing: "border-box",
      margin: "0.35em 0",
      // Keep the original figure measure exactly: the delineation must not
      // steal horizontal space from a wide diagram. An inset stroke is visual
      // only, unlike a border plus horizontal padding.
      padding: "0.8em 0 0.4em",
      borderRadius: "0.35em",
      boxShadow: "inset 0 0 0 1px color-mix(in srgb, currentColor 13%, transparent)",
      backgroundColor: "color-mix(in srgb, currentColor 1.8%, transparent)",
      cursor: "text",
      transition: "box-shadow 100ms ease, background-color 100ms ease",
    },
    ".tikz-figure.tikz-rendered:hover": {
      boxShadow: "inset 0 0 0 1px color-mix(in srgb, currentColor 24%, transparent)",
      backgroundColor: "color-mix(in srgb, currentColor 3.2%, transparent)",
    },
    ".tikz-rendered-frame": {
      position: "relative",
      display: "inline-block",
      // TeX already chose a physical box for the diagram. Match textbook and
      // reference-site behaviour by preserving that natural box; only shrink
      // when it would overflow the editor measure. Never enlarge a diagram to
      // fill a semantic width bucket.
      maxWidth: "min(96%, 68rem)",
      verticalAlign: "top",
    },
    ".tikz-rendered-frame svg": {
      display: "block",
      maxWidth: "100%",
      width: "auto",
      height: "auto",
      margin: "0 auto",
      maxHeight: "34rem",
    },
    // pdflatex output is black-on-transparent; invert it for dark themes
    // (the TikZ analog of mermaid's dark-theme reinitialization).
    "&dark .tikz-rendered-frame svg": {
      filter: "invert(0.85) hue-rotate(180deg)",
    },
    ".tikz-pending": {
      opacity: "0.6",
      fontStyle: "italic",
    },
    ".tikz-error": {
      display: "inline-block",
      textAlign: "left",
      border: "1px solid #c0392b",
      borderRadius: "4px",
      padding: "0.4em 0.8em",
      color: "#c0392b",
      cursor: "text",
    },
  }),
];
