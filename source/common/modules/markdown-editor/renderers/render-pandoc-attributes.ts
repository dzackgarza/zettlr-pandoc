/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PandocAttributesRenderer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Pandoc attribute blocks ({#id .class key=val}) attach to
 *                  headings, table captions, code blocks, images, and spans.
 *                  They are attribute machinery, not content: when a carrier
 *                  line is rendered, the block is hidden, and it reveals
 *                  again while the cursor is on the line — the same
 *                  reveal-on-cursor semantics the fenced-div renderer applies
 *                  to its open fence, shared through
 *                  rangeInPreviewSuppression and the
 *                  previewModeShowSyntaxWhenCursorIsAdjacent preference read
 *                  from the required editor configuration field.
 *
 * END HEADER
 */

import { type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { parsePandocAttributes } from "source/common/pandoc-util/parse-pandoc-attributes";
import { configField } from "../util/configuration";
import {
  rangeInPreviewSuppression,
  reviewSuppressionChanged,
} from "../util/range-in-preview-suppression";
import { visitVisibleSyntaxNodes } from "../util/visible-syntax-nodes";

function hideAttributeBlocks(view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = [];
  const hiddenDeco = Decoration.replace({});
  // The reveal-on-cursor behaviour is a user preference, so the configuration
  // is a hard dependency: this plugin is only installed by the renderer
  // aggregate, which the editor always builds alongside configField. Reading
  // the field as required means a state assembled without it reports that
  // wiring defect instead of quietly picking a preference the user never set.
  const includeAdjacent = view.state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent;

  visitVisibleSyntaxNodes(view, (node) => {
    if (node.name !== "PandocAttribute") {
      return;
    }

    // Attribute nodes inside span and div constructs belong to the
    // pandoc div/span renderer, which owns their editing presentation.
    for (let parent = node.node.parent; parent !== null; parent = parent.parent) {
      if (parent.name === "PandocSpan" || parent.name.startsWith("PandocDiv")) {
        return;
      }
    }

    // Only hide blocks that actually parse as Pandoc attributes; a brace
    // group carrying none stays visible as the prose it probably is.
    const parsed = parsePandocAttributes(view.state.sliceDoc(node.from, node.to));
    if (
      parsed.id === undefined &&
      parsed.classes === undefined &&
      parsed.properties === undefined
    ) {
      return;
    }

    // A ViewPlugin may not provide replacement decorations spanning line
    // breaks. Multiline attribute-like source is therefore never hidden
    // here. Dedicated block renderers (for example fenced Pandoc divs)
    // must own multiline presentation; otherwise the authored source stays
    // visible rather than corrupting CodeMirror's height map.
    const firstLine = view.state.doc.lineAt(node.from);
    const lastLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1));
    if (firstLine.number !== lastLine.number) {
      return;
    }

    // Reveal while the cursor is anywhere on the carrier line: hiding is
    // a line-rendering concern, and cursor-on-line is the editing state.
    const line = firstLine;
    if (rangeInPreviewSuppression(view.state, line.from, line.to, includeAdjacent)) {
      return;
    }

    // Swallow the run of spaces before the block so hiding leaves no
    // trailing gap after the carrier's text.
    let start = node.from;
    while (start > line.from && view.state.sliceDoc(start - 1, start) === " ") {
      start--;
    }

    ranges.push(hiddenDeco.range(start, node.to));
  });

  return Decoration.set(ranges, true);
}

export const renderPandocAttributes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = hideAttributeBlocks(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        reviewSuppressionChanged(update)
      ) {
        this.decorations = hideAttributeBlocks(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
