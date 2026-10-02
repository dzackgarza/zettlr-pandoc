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
 *                  source. Overlay controls rebuild the figure or open its
 *                  visual editor (Quiver for tikzcd).
 *
 * END HEADER
 */

import { type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { reportError } from "@common/util/error-reporting";
import { sanitizedFragment } from "@common/util/sanitize-html";
import { type SyntaxNodeRef } from "@lezer/common";
import type { TikzSourceBlock } from "tikz-workbench/src/source-block";
import type { TikzRenderResult } from "tikz-workbench/src/tikz-render";
import { tikzBlockForNode } from "../tikz-block";
import { tikzWidthEm } from "../tikz-display-size";
import { requestTikzRender } from "../tikz-render-client";
import { configField } from "../util/configuration";
import { renderBlockWidgets } from "./base-renderer";

export const OPEN_TIKZ_VISUAL_EDITOR_EVENT = "open-tikz-visual-editor";

/**
 * One in-flight render per figure source. Settled requests are removed: the
 * main process/filter own the durable content-addressed cache, and keeping a
 * second settled cache here would make the live preview's explicit Force
 * rerender invisible when the caret later leaves the block and this inline
 * widget returns.
 */
export { __resetTikzRenderMemoForTests } from "../tikz-render-client";

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
  const fragment = sanitizedFragment(html, "graphic");

  // An ok result is only issued after the service confirmed the pandoc output
  // carries an <svg>…</svg>; markup without one means service and widget
  // disagree about what a successful render is, which no presentation can
  // repair.
  if (fragment.querySelector("svg") === null) {
    throw new Error(
      "render-tikz: the render service reported a successful figure whose markup carries no <svg> element. " +
        `Markup received (${html.length} chars): ${html.slice(0, 200)}. ` +
        "renderTikz in tikz-workbench/src/tikz-render.ts only returns ok after matching <svg>…</svg> in the " +
        "pandoc output, so either that check or this widget must change.",
    );
  }

  const nodes: Node[] = [];
  for (const child of Array.from(fragment.childNodes)) {
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

function populate(
  elem: HTMLElement,
  result: TikzRenderResult,
  editTitle: string,
  editSource: () => void,
): void {
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
  let diagnosticText = "";
  let summary: string;

  switch (result.kind) {
    case "missing-tools":
      summary = `TikZ rendering requires tools that were not found: ${result.missing.join(", ")}`;
      break;
    case "toolchain-probe-failed":
      // Deliberately not "install this tool": the tool may well be installed.
      // The errno is the whole diagnosis — EACCES is a permission bit, EAGAIN
      // is resource exhaustion — and telling the user to install something
      // instead would send them after the wrong problem.
      summary = `TikZ could not check whether ${result.tool} is usable: the check failed with ${result.code}`;
      break;
    case "compile-error": {
      summary = "TikZ compilation failed";
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
      diagnosticText =
        result.log ||
        result.errors
          .map((error) => `line ${error.line}: ${error.message}\n${error.sourceLine}`)
          .join("\n\n");
      if (result.log !== "") {
        const log = document.createElement("pre");
        log.classList.add("tikz-compiler-log");
        log.textContent = result.log;
        box.appendChild(log);
      } else if (result.errors.length === 0) {
        const note = document.createElement("div");
        note.textContent = "The compiler returned no output.";
        box.appendChild(note);
      }
      break;
    }
    case "pandoc-error": {
      summary = "TikZ render failed (pandoc error)";
      diagnosticText = result.log;
      const log = document.createElement("pre");
      log.textContent = result.log;
      box.appendChild(log);
      break;
    }
    case "render-terminated": {
      // Naming the signal is the point: a killed render is not pandoc
      // reporting anything about the figure, and the user needs to know the
      // difference to act on it.
      summary = `TikZ render was killed by ${result.signal} before it finished`;
      diagnosticText = result.log;
      const log = document.createElement("pre");
      log.textContent = result.log;
      box.appendChild(log);
      break;
    }
    default: {
      const unhandled: never = result;
      throw new Error(
        `render-tikz: unhandled TikzRenderResult case ${JSON.stringify(unhandled)}. ` +
          "The union lives in tikz-workbench/src/tikz-render.ts; every case it declares must be presented here.",
      );
    }
  }
  title.textContent = summary;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy diagnostics";
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(diagnosticText === "" ? summary : diagnosticText)
      .catch((error) => {
        reportError("Could not copy TikZ diagnostics", error);
      });
  });
  box.insertBefore(copy, title);
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit source";
  edit.addEventListener("click", editSource);
  box.insertBefore(edit, title);

  elem.replaceChildren(box);
}

class TikzWidget extends WidgetType {
  /**
   * The widget holds the figure and the length of the authored block, not the
   * position of the block: an edit before the figure moves the block and keeps
   * this widget.
   */
  constructor(
    readonly source: string,
    readonly kind: TikzSourceBlock["kind"],
    readonly language: TikzSourceBlock["language"],
    readonly blockLength: number,
  ) {
    super();
  }

  eq(other: TikzWidget): boolean {
    return (
      other.source === this.source &&
      other.kind === this.kind &&
      other.language === this.language &&
      other.blockLength === this.blockLength
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const elem = document.createElement("div");
    elem.classList.add("tikz-figure", "tikz-pending");
    elem.dataset.tikzLanguage = this.language;
    elem.dataset.tikzKind = this.kind;
    elem.textContent = "Rendering TikZ figure…";
    const block = document.createElement("div");

    // The configuration carries the buffer's path, using the empty string for
    // a buffer that has none — the same value the request field is declared
    // against. This renderer is only ever installed alongside configField, so
    // its absence is a wiring defect and reads as one.
    const docPath = view.state.field(configField).metadata.path;
    const editTitle = "Click to edit TikZ source";
    const editSource = (): void => {
      const from = view.posAtDOM(block);
      view.focus();
      view.dispatch({ selection: { anchor: from, head: from + this.blockLength } });
    };
    let renderVersion = 0;
    const render = (cachePolicy: "use" | "refresh"): void => {
      const version = ++renderVersion;
      elem.classList.add("tikz-pending");
      requestTikzRender({
        source: this.source,
        kind: this.kind,
        language: this.language,
        docPath,
        cachePolicy,
      }).then(
        (result) => {
          if (version !== renderVersion) return;
          populate(elem, result, editTitle, editSource);
        },
        // Only the IPC round-trip is handled here. A failure to reach the main
        // process is a render failure the user must see; a failure raised by
        // populate is a broken service/widget contract and must not be dressed
        // up as one of the render service's outcomes.
        (err: unknown) => {
          if (version !== renderVersion) return;
          reportError("TikZ inline render IPC failed", err);
          populate(
            elem,
            {
              ok: false,
              kind: "pandoc-error",
              log: err instanceof Error ? err.message : String(err),
            },
            editTitle,
            editSource,
          );
        },
      );
    };
    render("use");

    const actions = document.createElement("div");
    actions.className = "tikz-figure-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "tikz-figure-action";
    refresh.textContent = "↻";
    refresh.title = "Rebuild TikZ figure";
    refresh.setAttribute("aria-label", "Rebuild TikZ figure");
    refresh.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      render("refresh");
    });
    const visual = document.createElement("button");
    visual.type = "button";
    visual.className = "tikz-figure-action";
    visual.textContent = this.language === "tikzcd" ? "Quiver" : "Visual";
    visual.title = this.language === "tikzcd" ? "Open Quiver editor" : "Open visual editor";
    visual.setAttribute("aria-label", visual.title);
    visual.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      editSource();
      view.dom.dispatchEvent(
        new CustomEvent(OPEN_TIKZ_VISUAL_EDITOR_EVENT, { bubbles: true, detail: this.language }),
      );
    });
    actions.append(refresh, visual);

    // A click on the figure selects its authored source. The overlay buttons
    // have their own actions and do not enter source editing.
    elem.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button, .tikz-error") !== null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      editSource();
    });

    // CodeMirror measures a block widget by its border box, so the space
    // around the figure is padding on this root, never a margin on the figure.
    block.classList.add("tikz-figure-block");
    block.append(elem, actions);
    return block;
  }

  updateDOM(_dom: HTMLElement, _view: EditorView): boolean {
    return false; // Source changed: rebuild and re-render.
  }

  ignoreEvent(_event: Event): boolean {
    return true; // The widget owns edit activation and its explicit expand control.
  }
}

function shouldHandleNode(node: SyntaxNodeRef): boolean {
  return node.type.name === "RawBlock" || node.type.name === "FencedCode";
}

function createWidget(state: EditorState, node: SyntaxNodeRef): TikzWidget | undefined {
  const block = tikzBlockForNode(state, node);
  return block === undefined
    ? undefined
    : new TikzWidget(block.source, block.kind, block.language, block.to - block.from);
}

export const renderTikzFigures = [
  renderBlockWidgets(["RawBlock", "FencedCode"], shouldHandleNode, createWidget),
  EditorView.baseTheme({
    ".tikz-figure-block": {
      display: "block",
      padding: "0.35em 0",
      position: "relative",
    },
    ".tikz-figure-actions": {
      position: "absolute",
      top: "0.7em",
      right: "0.45em",
      display: "flex",
      gap: "0.3em",
      opacity: "0.42",
      transition: "opacity 120ms ease",
    },
    ".tikz-figure-block:hover .tikz-figure-actions, .tikz-figure-actions:focus-within": {
      opacity: "1",
    },
    ".tikz-figure-action": {
      border: "1px solid currentColor",
      borderRadius: "0.3em",
      background: "Canvas",
      color: "inherit",
      cursor: "pointer",
      font: "inherit",
      padding: "0.15em 0.45em",
    },
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
      userSelect: "text",
      WebkitUserSelect: "text",
    },
    ".tikz-error *": {
      userSelect: "text",
      WebkitUserSelect: "text",
    },
    ".tikz-error button": {
      display: "block",
      marginBottom: "0.4em",
      cursor: "pointer",
    },
    ".tikz-compiler-log": {
      maxHeight: "18rem",
      maxWidth: "min(80vw, 64rem)",
      overflow: "auto",
      whiteSpace: "pre-wrap",
    },
  }),
];
