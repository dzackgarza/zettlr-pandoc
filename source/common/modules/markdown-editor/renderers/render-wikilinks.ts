/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        WikilinkRenderer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Renders each wikilink that names exactly one document as a
 *                  chip, as render-reference-chips renders a resolved
 *                  reference. The chip shows the label, or else the target
 *                  and its `#heading`. A missing or ambiguous link stays raw;
 *                  the Flowmark diagnostics own those states.
 *
 *                  A click reveals the source; a Mod-click opens the link.
 *
 * END HEADER
 */

import { type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { splitWikilinkTarget } from "@common/util/wikilink-target";
import { type SyntaxNodeRef } from "@lezer/common";
import { wikilinkOpener, wikilinkResolutionsField } from "../plugins/wikilink-resolutions-field";
import { renderBlockWidgets } from "./base-renderer";
import clickAndSelect from "./click-and-select";

class WikilinkChipWidget extends WidgetType {
  /** `documentPath` is '' for a link into the document itself (`[[#heading]]`). */
  constructor(
    readonly linkContents: string,
    readonly label: string,
    readonly documentPath: string,
  ) {
    super();
  }

  eq(other: WikilinkChipWidget): boolean {
    return (
      other.linkContents === this.linkContents &&
      other.label === this.label &&
      other.documentPath === this.documentPath
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const elem = document.createElement("span");
    elem.classList.add("wikilink-chip");
    elem.dataset.wikilinkTarget = this.linkContents;
    if (this.documentPath !== "") {
      elem.title = this.documentPath;
    }
    elem.textContent = this.label;

    // Widget mouse events never reach the clickListeners() mousedown path
    // (ignoreEvent below), so the Mod-click lives here. It runs on
    // mousedown: the default mousedown moves the caret next to the link,
    // which reveals the source before a click event could arrive.
    const revealSource = clickAndSelect(view);
    let openedOnMousedown = false;
    elem.addEventListener("mousedown", (event) => {
      openedOnMousedown = false;
      const cmd = event.metaKey && process.platform === "darwin";
      const ctrl = event.ctrlKey && process.platform !== "darwin";
      const open = view.state.facet(wikilinkOpener);
      if ((!cmd && !ctrl) || open === undefined) {
        return;
      }
      event.preventDefault();
      openedOnMousedown = true;
      open(this.linkContents);
    });
    elem.addEventListener("click", (event) => {
      if (openedOnMousedown) {
        openedOnMousedown = false;
        return;
      }
      revealSource(event);
    });

    return elem;
  }

  ignoreEvent(event: Event): boolean {
    return event instanceof MouseEvent;
  }
}

function shouldHandleNode(node: SyntaxNodeRef): boolean {
  return node.type.name === "ZknLink";
}

function createWidget(state: EditorState, node: SyntaxNodeRef): WidgetType | undefined {
  const resolutions = state.field(wikilinkResolutionsField, false);
  const content = node.node.getChild("ZknLinkContent");
  if (resolutions === undefined || resolutions === null || content === null) {
    return undefined;
  }

  const linkContents = state.sliceDoc(content.from, content.to);
  const { target, fragment } = splitWikilinkTarget(linkContents);
  let documentPath = "";
  if (target !== "") {
    const resolution = resolutions.get(target);
    if (resolution === undefined || resolution.status !== "resolved") {
      return undefined;
    }
    documentPath = resolution.path;
  }

  const title = node.node.getChild("ZknLinkTitle");
  const written =
    fragment === undefined || fragment === ""
      ? target
      : target === ""
        ? fragment
        : `${target} › ${fragment}`;
  const label = title !== null ? state.sliceDoc(title.from, title.to) : written;
  return new WikilinkChipWidget(linkContents, label, documentPath);
}

const chipTheme = EditorView.baseTheme({
  ".wikilink-chip": {
    display: "inline-block",
    padding: "0 0.4em",
    margin: "0 0.05em",
    borderRadius: "4px",
    fontSize: "90%",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  "&light .wikilink-chip": {
    backgroundColor: "rgba(46, 125, 50, 0.12)",
    border: "1px solid rgba(46, 125, 50, 0.35)",
    color: "#2e6b32",
  },
  "&dark .wikilink-chip": {
    backgroundColor: "rgba(129, 199, 132, 0.18)",
    border: "1px solid rgba(129, 199, 132, 0.4)",
    color: "#a5d6a7",
  },
});

export const renderWikilinks = [
  renderBlockWidgets(
    ["ZknLink"],
    shouldHandleNode,
    createWidget,
    (before, after) =>
      before.field(wikilinkResolutionsField, false) !==
      after.field(wikilinkResolutionsField, false),
  ),
  chipTheme,
];
