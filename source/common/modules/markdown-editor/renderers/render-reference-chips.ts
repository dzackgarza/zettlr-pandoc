/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceChipRenderer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Renders every RESOLVED workspace reference occurrence as
 *                  an independent compact editor-local numbered chip.
 *
 *                  CONTRACT (locked by test/editor-reference-chips.spec.ts):
 *
 *                  - The renderer handles a Citation syntax node only when
 *                    EVERY item in the cluster carries a supported reference
 *                    family key (CROSSREF_FAMILIES plus the theorem-div
 *                    prefixes). Pure bibliography clusters stay with
 *                    render-citations byte-identically; mixed
 *                    bibliography/reference clusters are handled by NEITHER
 *                    renderer — they stay raw and receive an advisory
 *                    diagnostic from the standalone Flowmark reference rules.
 *                  - Each resolved item renders as one independent chip
 *                    (span.reference-chip with data-reference-key and
 *                    data-reference-family) whose text is `<Type> N.N.N`.
 *                    These numbers are deterministic inside Zettlr and are
 *                    deliberately independent of export numbering.
 *                  - Authored cluster punctuation, prefixes, suffixes, and
 *                    locators are preserved verbatim around the chips: the
 *                    widget text is the authored cluster text with each
 *                    `@key` token replaced by its chip and the enclosing
 *                    brackets dropped.
 *                  - An occurrence whose key is missing or duplicate renders
 *                    NO chip: the authored source stays raw (diagnostics own
 *                    those states; duplicates never select one definition
 *                    silently).
 *                  - Export tools and templates still exclusively own the
 *                    number appearing in exported documents. The editor-local
 *                    number is a stable authoring aid, not an export preview.
 *                  - The workspace view comes exclusively from
 *                    workspaceReferencesField; while the field is null
 *                    nothing renders.
 *
 *                  TAKEOVER DESIGN (green step): render-citations declines a
 *                  cluster at createWidget time whenever the state carries
 *                  workspaceReferencesField AND any item is supported-family
 *                  (states without the field keep the legacy textual
 *                  crossref branch, which test/pandoc-quick-help.spec.ts
 *                  locks). This renderer takes exactly the all-supported,
 *                  all-resolved clusters; partially or fully unresolved
 *                  clusters and mixed clusters stay raw. Bibliography-only
 *                  clusters keep byte-identical decoration DOM (the parity
 *                  MUST-assert of the spec).
 *
 * END HEADER
 */

import { type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import {
  type ReferenceFamily,
  referenceFamilyDisplayName,
  referenceFamilyOf,
} from "@dts/common/references";
import { type SyntaxNodeRef } from "@lezer/common";
import { NODES, nodeToCiteItem } from "../parser/citation-parser";
import { referencePresentationField } from "../plugins/workspace-references-field";
import {
  followReferenceNavigationIntent,
  resolveReferenceNavigationIntent,
} from "../util/reference-navigation";
import { renderBlockWidgets } from "./base-renderer";
import clickAndSelect from "./click-and-select";

/**
 * One chip of a cluster widget: the authored key, its family, and the
 * editor-local display text (`Type N.N.N`).
 */
interface ChipSpec {
  key: string;
  family: ReferenceFamily;
  label: string;
}

class ReferenceChipClusterWidget extends WidgetType {
  constructor(
    readonly rawCluster: string,
    readonly chips: ChipSpec[],
  ) {
    super();
  }

  eq(other: ReferenceChipClusterWidget): boolean {
    return (
      other.rawCluster === this.rawCluster &&
      JSON.stringify(other.chips) === JSON.stringify(this.chips)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const elem = document.createElement("span");
    elem.classList.add("reference-chip-cluster");

    // The widget text is the authored cluster text with the enclosing
    // brackets dropped and each `@key` token replaced by its chip; every
    // other authored character (prefixes, separators, locators, suffixes)
    // is preserved verbatim.
    const bracketed = this.rawCluster.startsWith("[") && this.rawCluster.endsWith("]");
    const inner = bracketed ? this.rawCluster.slice(1, -1) : this.rawCluster;

    let cursor = 0;
    for (const chip of this.chips) {
      const token = "@" + chip.key;
      const idx = inner.indexOf(token, cursor);
      if (idx === -1) {
        // Structurally impossible for clusters accepted by createWidget;
        // keep the remaining text authored rather than guessing.
        break;
      }

      if (idx > cursor) {
        elem.appendChild(document.createTextNode(inner.slice(cursor, idx)));
      }

      const chipElem = document.createElement("span");
      chipElem.classList.add("reference-chip");
      chipElem.dataset.referenceKey = chip.key;
      chipElem.dataset.referenceFamily = chip.family;
      chipElem.textContent = chip.label;
      elem.appendChild(chipElem);

      cursor = idx + token.length;
    }

    if (cursor < inner.length) {
      elem.appendChild(document.createTextNode(inner.slice(cursor)));
    }

    // Ordinary clicks reveal the authored source (edit-first parity). A
    // platform Mod-click instead follows the clicked chip's reference to its
    // definition (issue #1 Phase 5). Widget mouse events never reach the
    // clickListeners() mousedown path (ignoreEvent below), so the navigation
    // branch lives on the widget listener itself. It runs on mousedown: the
    // browser's default mousedown puts the caret beside the cluster, which
    // un-renders this widget before any click event could reach it.
    const revealAuthoredSource = clickAndSelect(view);
    let navigatedOnMousedown = false;
    elem.addEventListener("mousedown", (event) => {
      navigatedOnMousedown = false;
      const cmd = event.metaKey && process.platform === "darwin";
      const ctrl = event.ctrlKey && process.platform !== "darwin";
      if (!cmd && !ctrl) {
        return;
      }
      const chip =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>(".reference-chip")
          : null;
      const pos = view.posAtDOM(elem);
      const intent = resolveReferenceNavigationIntent(view, pos, chip?.dataset.referenceKey);
      if (intent === null) {
        return;
      }
      event.preventDefault();
      navigatedOnMousedown = true;
      followReferenceNavigationIntent(view, intent);
    });
    elem.addEventListener("click", (event) => {
      if (navigatedOnMousedown) {
        navigatedOnMousedown = false;
        return;
      }
      revealAuthoredSource(event);
    });

    return elem;
  }

  ignoreEvent(event: Event): boolean {
    return event instanceof MouseEvent;
  }
}

function shouldHandleNode(node: SyntaxNodeRef): boolean {
  return node.type.name === NODES.CITATION;
}

function createWidget(state: EditorState, node: SyntaxNodeRef): WidgetType | undefined {
  // No workspace view yet: there are no display numbers and nothing renders.
  const displayNumbers = state.field(referencePresentationField, false)?.displayNumbers;
  if (displayNumbers === undefined) {
    return undefined;
  }

  const rawCluster = state.sliceDoc(node.from, node.to);
  const citation = nodeToCiteItem(node.node, rawCluster, node.from);
  if (citation.items.length === 0) {
    return undefined;
  }

  const chips: ChipSpec[] = [];
  for (const item of citation.items) {
    const family = referenceFamilyOf(item.id);
    if (family === undefined) {
      // A bibliography key: this is a pure bibliography or mixed cluster,
      // and neither renders through the chips renderer.
      return undefined;
    }

    // Only a uniquely resolved key has a display number. A missing or
    // duplicate key stays raw: diagnostics own those states, and a duplicate
    // never selects one definition silently.
    const displayNumber = displayNumbers.get(item.id);
    if (displayNumber === undefined) {
      return undefined;
    }
    chips.push({
      key: item.id,
      family,
      label: `${referenceFamilyDisplayName(family)} ${displayNumber}`,
    });
  }

  return new ReferenceChipClusterWidget(rawCluster, chips);
}

function displayNumbersChanged(before: EditorState, after: EditorState): boolean {
  return (
    before.field(referencePresentationField, false)?.displayNumbers !==
    after.field(referencePresentationField, false)?.displayNumbers
  );
}

/**
 * Base styling for the chip presentation: compact pills that stay legible in
 * both light and dark themes without ever displaying a computed number.
 */
const chipTheme = EditorView.baseTheme({
  ".reference-chip": {
    display: "inline-block",
    padding: "0 0.4em",
    margin: "0 0.05em",
    borderRadius: "4px",
    fontSize: "90%",
    whiteSpace: "nowrap",
  },
  "&light .reference-chip": {
    backgroundColor: "rgba(28, 120, 176, 0.12)",
    border: "1px solid rgba(28, 120, 176, 0.35)",
    color: "#1c5f8a",
  },
  "&dark .reference-chip": {
    backgroundColor: "rgba(93, 173, 226, 0.18)",
    border: "1px solid rgba(93, 173, 226, 0.4)",
    color: "#9ecbe8",
  },
});

export const renderReferenceChips = [
  renderBlockWidgets([NODES.CITATION], shouldHandleNode, createWidget, displayNumbersChanged),
  chipTheme,
];
