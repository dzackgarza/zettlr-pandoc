/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MathRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer displays math equations.
 *
 * END HEADER
 */

import { type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { type SyntaxNodeRef } from "@lezer/common";
import { pandocLatexMathEnvironmentAtStart } from "@lezer/markdown";
import { stripMathDelimiters } from "source/common/util/math-delimiters";
import { mathJaxToElem } from "source/common/util/mathtex-to-html";
import { equationMenu } from "../context-menu/equation-menu";
import { configField } from "../util/configuration";
import { rangeInPreviewSuppression } from "../util/range-in-preview-suppression";
import { renderBlockWidgets } from "./base-renderer";
import clickAndSelect from "./click-and-select";

class MathWidget extends WidgetType {
  constructor(
    readonly equation: string,
    readonly displayMode: boolean,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.equation === this.equation && other.displayMode === this.displayMode;
  }

  toDOM(view: EditorView): HTMLElement {
    const elem = document.createElement("span");
    elem.classList.add("preview-math");
    elem.dataset.equation = this.equation;
    mathJaxToElem(this.equation, elem, this.displayMode ? "display" : "inline");
    elem.addEventListener("click", clickAndSelect(view));
    elem.addEventListener("contextmenu", (event) => {
      equationMenu(view, this.equation, { x: event.clientX, y: event.clientY });
    });
    return elem;
  }

  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    if (dom.dataset.equation === this.equation) {
      return true; // No need to update
    }

    dom.dataset.equation = this.equation;
    mathJaxToElem(this.equation, dom, this.displayMode ? "display" : "inline");
    return true;
  }

  ignoreEvent(event: Event): boolean {
    return true; // By default ignore all events
  }
}

function shouldHandleNode(node: SyntaxNodeRef): boolean {
  // Pandoc keeps LaTeX math environments such as align/equation as
  // RawInline(tex). The syntax node stays RawInline; createWidget checks the
  // exact Pandoc math-environment subset before rendering it with MathJax.
  if (node.type.name === "RawInline") {
    return true;
  }

  // This parser should look for InlineCode and FencedCode and then immediately
  // check its first CodeMark child to ensure its contents only include $ or $$.
  if (!["InlineCode", "FencedCode"].includes(node.type.name)) {
    return false;
  }

  // We've got some code. Let's now make sure that we have a CodeMark and it's
  // either 2 long (if FencedCode) or 1-2 (if InlineCode)
  const firstChild = node.node.firstChild; // Accessing node.node will force-calc the tree here
  if (firstChild === null || firstChild.type.name !== "CodeMark") {
    return false;
  }

  const markSpan = firstChild.to - firstChild.from;

  if (markSpan !== 2 && node.type.name === "FencedCode") {
    return false;
  }

  return true; // There's reason to assume we are indeed dealing with a math equation
}

function createWidget(state: EditorState, node: SyntaxNodeRef): MathWidget | undefined {
  // Get the node's text contents, determine if this is a displayMode equation,
  // and then remove the leading and trailing dollars.
  const includeAdjacent = state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent;

  // Don't render if the selection is within the node
  if (rangeInPreviewSuppression(state, node.from, node.to, includeAdjacent)) {
    return undefined;
  }

  const nodeText = state.sliceDoc(node.from, node.to);

  if (node.type.name === "RawInline") {
    const environment = pandocLatexMathEnvironmentAtStart(nodeText);
    if (environment === null || environment.end !== nodeText.length) {
      return undefined;
    }
    return new MathWidget(nodeText, environment.display);
  }

  // Recognizes $…$, $$…$$, \(…\) and \[…\]; returns null for regular code.
  const math = stripMathDelimiters(nodeText);
  if (math === null) {
    return undefined; // It's regular FencedCode/InlineCode
  }

  return new MathWidget(math.equation, math.display);
}

export const renderMath = [
  renderBlockWidgets(["InlineCode", "FencedCode", "RawInline"], shouldHandleNode, createWidget),
  EditorView.baseTheme({
    // MathJax CommonHTML overrides
    "mjx-container": {
      fontSize: "1.1em", // reduce font-size of math a bit
      display: "inline-block", // needed for display math to behave properly
      userSelect: "none", // Disable user text selection
    },
    'mjx-container[display="true"]': {
      width: "100%", // display math should be centered
    },
  }),
];
