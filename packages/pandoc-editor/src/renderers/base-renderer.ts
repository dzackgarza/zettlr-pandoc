/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Base Renderer
 * CVM-Role:        Utility Class
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module defines two base-renderers that are used by all
 *                  rendering plugins. Rendering plugins can either define a
 *                  block renderer or an inline renderer depending on the need.
 *
 * END HEADER
 */

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  findClusterBreak,
  Prec,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type SyntaxNodeRef } from "@lezer/common";
import { previewConfiguration } from "../util/configuration";
import { incrementalNodeDecorations } from "../util/incremental-node-decorations";
import {
  previewSuppressionChangedRanges,
  rangeInPreviewSuppression,
  reviewSuppressionChanged,
} from "../util/range-in-preview-suppression";
import { visitVisibleSyntaxNodes } from "../util/visible-syntax-nodes";

/**
 * Whether a state value that a renderer's `createWidget` reads changed between
 * two states. The node's own text and the selection are not such values.
 */
export type RendererInputsChanged = (before: EditorState, after: EditorState) => boolean;

interface RendererSpec {
  nodeTypes: ReadonlySet<string>;
  shouldHandleNode: (node: SyntaxNodeRef) => boolean;
  createWidget: (state: EditorState, node: SyntaxNodeRef) => WidgetType | undefined;
  inputsChanged: RendererInputsChanged;
}

const blockRendererFacet = Facet.define<RendererSpec, readonly RendererSpec[]>({
  combine: (values) => values,
});

/**
 * The visual-indent plugin hangs list markers outside the text block by
 * applying a negative `text-indent` to the `.cm-line`. `text-indent` is
 * inherited and applies to the first line inside any block container, so
 * every widget whose DOM establishes one (`inline-block` included) would
 * have its first-line content pulled leftward out of its own box, over
 * whatever text precedes it. Every widget produced through this module
 * carries this class so a renderer cannot inherit line-level indent by
 * omission. Widget paths that cannot route through this module (the table
 * editor's block widget) add the class themselves.
 */
export const WIDGET_LINE_STYLE_RESET_CLASS = "cm-widget-line-style-reset";

/**
 * How a widget stays on the row of the characters that touch it: the bracket
 * before an equation and the comma after a chip do not go to another row than
 * the widget. A space beside the widget can still end the row.
 *
 * - `"box"`: the widget is one box (an equation, a pill). No row ends in it.
 * - `"text"`: the widget holds text whose rows end where the rows of text
 *   end (a citation, a cluster of chips with its authored words).
 * - `null`: no character is joined to the widget. This is the value for a
 *   widget that fills the row (display math): such a widget joined to a
 *   character is wider than the row.
 */
export type RowJoin = "box" | "text" | null;

/** A widget that states its `RowJoin`. A widget without it is not joined. */
export interface RowJoinedWidget {
  readonly rowJoin: RowJoin;
}

function rowJoinOf(widget: WidgetType): RowJoin {
  return "rowJoin" in widget && (widget.rowJoin === "box" || widget.rowJoin === "text")
    ? widget.rowJoin
    : null;
}

/**
 * The class of the mark that holds a row-joined widget and the characters
 * that touch it.
 *
 * The view puts an image of no width (`cm-widgetBuffer`) before and after
 * each widget, so that the caret has a place beside content that is not
 * editable. An image is an atomic inline, and a browser can end a row before
 * and after each atomic inline (CSS Text 3, section 5.1, "Line Breaking
 * Details"). The `text-wrap-mode` of the nearest common ancestor of two boxes
 * decides whether a row can end between them (the same section), so the mark
 * permits no row end in it. The buffers keep their place and their size: the
 * caret beside a widget does not move.
 */
const ROW_JOIN_CLASS = "cm-row-join";

/**
 * The class of a widget in the mark that holds text with row ends of its own
 * (`RowJoin` `"text"`). The widget permits row ends in it again.
 *
 * Chromium takes the row end after the last content of an element from the
 * style of that element, not from the mark around it. The widget therefore
 * ends in a U+2060 WORD JOINER that permits no row end: no row ends before a
 * word joiner (UAX #14, rule LB11), and none after this one.
 */
const ROW_JOIN_TEXT_CLASS = "cm-row-join-text";

/**
 * The class of an inline element in a widget that holds one atomic inline box
 * (an `inline-block` pill) and nothing else. No row ends between that box and
 * a character of the widget that touches the element.
 *
 * Chromium ends a row beside an atomic inline also when a U+2060 WORD JOINER
 * is the character on that side. The element therefore puts a word joiner on
 * each side of the box, in generated content, and permits no row end in it.
 * No row ends between a word joiner and the character beside it (UAX #14,
 * rule LB11).
 */
export const ATOMIC_INLINE_JOINT_CLASS = "cm-atomic-inline-joint";

// The rows of a line end only in an editor with `EditorView.lineWrapping`.
const widgetTheme = EditorView.baseTheme({
  [`.${WIDGET_LINE_STYLE_RESET_CLASS}`]: {
    textIndent: "0",
  },
  [`.cm-lineWrapping .${ROW_JOIN_CLASS}, .cm-lineWrapping .${ATOMIC_INLINE_JOINT_CLASS}`]: {
    textWrapMode: "nowrap",
  },
  [`.cm-lineWrapping .${ROW_JOIN_CLASS} .${ROW_JOIN_TEXT_CLASS}`]: {
    textWrapMode: "wrap",
  },
  [`.cm-lineWrapping .${ROW_JOIN_CLASS} .${ROW_JOIN_TEXT_CLASS}::after`]: {
    content: '"\\2060"',
    textWrapMode: "nowrap",
  },
  [`.${ATOMIC_INLINE_JOINT_CLASS}::before, .${ATOMIC_INLINE_JOINT_CLASS}::after`]: {
    content: '"\\2060"',
  },
});

// A widget replaces its source with a decoration that is not inclusive. Of a
// mark and such a decoration that start or end at one position, the view
// puts the widget in the mark only when the mark is inclusive.
const rowJoinMark = Decoration.mark({ class: ROW_JOIN_CLASS, inclusive: true });

/**
 * The range of a row-joined widget and the characters of its lines that
 * touch it. A space is not such a character. Two widgets with one character
 * between them give two ranges that both hold that character; the view draws
 * equal marks that overlap as one element.
 */
function rowJoinRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  const first = state.doc.lineAt(from);
  const last = to <= first.to ? first : state.doc.lineAt(to);
  const before = findClusterBreak(first.text, from - first.from, false);
  const after = findClusterBreak(last.text, to - last.from, true);
  return {
    from: /\S/.test(first.text.slice(before, from - first.from)) ? first.from + before : from,
    to: /\S/.test(last.text.slice(to - last.from, after)) ? last.from + after : to,
  };
}

/**
 * A widget owns the whole source of its node. Other renderers hide single
 * marks with their own replacements, and a node can start with such a mark:
 * the `$` of an equation is a code mark, which the emphasis renderer hides.
 * Of two replacements that start at one position, the view draws the one of
 * the higher precedence first and gives the other only the rest of its range.
 * The widget would then start after the mark, and `view.posAtDOM` would give
 * that position instead of the start of the source. The widget decorations
 * therefore take precedence over the decorations of ordinary extensions.
 */
const widgetDecorationPrecedence = Prec.high;

/**
 * Wraps a renderer's widget so its DOM is stamped with the line-style reset
 * class and with the length of the source it replaces. Everything else —
 * identity, events, geometry, lifecycle — delegates to the wrapped widget.
 *
 * The widget holds no document position. A widget outside a changed block is
 * kept across the transaction, so a position that it held would go stale;
 * `view.posAtDOM` gives the start of its source when a handler needs it.
 */
class LineStyleResetWidget extends WidgetType {
  constructor(
    readonly inner: WidgetType,
    readonly sourceLength: number,
  ) {
    super();
  }

  eq(other: LineStyleResetWidget): boolean {
    return (
      other.sourceLength === this.sourceLength &&
      other.inner.constructor === this.inner.constructor &&
      this.inner.eq(other.inner)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = this.inner.toDOM(view);
    this.stamp(dom);
    return dom;
  }

  private stamp(dom: HTMLElement): void {
    dom.classList.add(WIDGET_LINE_STYLE_RESET_CLASS);
    dom.classList.toggle(ROW_JOIN_TEXT_CLASS, rowJoinOf(this.inner) === "text");
    dom.dataset.previewSourceLength = String(this.sourceLength);
  }

  updateDOM(dom: HTMLElement, view: EditorView, from: LineStyleResetWidget): boolean {
    // CodeMirror recycles a widget's element when the two widgets share a
    // constructor, which every renderer now does through this wrapper. `dom`
    // therefore belongs to whichever renderer produced it, and a renderer that
    // adopts it keeps that renderer's classes -- a citation's element filled
    // with math keeps the citation background. Refuse across renderers so
    // CodeMirror builds a fresh element instead.
    if (from.inner.constructor !== this.inner.constructor) {
      return false;
    }
    // @codemirror/view's WidgetType.updateDOM is (dom, view, from) where `from`
    // is the previous widget of this type; forward the previous INNER widget so
    // the wrapped renderer sees its own predecessor, not this wrapper.
    const updated = this.inner.updateDOM(dom, view, from.inner);
    if (updated) {
      this.stamp(dom);
    }
    return updated;
  }

  ignoreEvent(event: Event): boolean {
    return this.inner.ignoreEvent(event);
  }

  get estimatedHeight(): number {
    return this.inner.estimatedHeight;
  }

  get lineBreaks(): number {
    return this.inner.lineBreaks;
  }

  coordsAt(dom: HTMLElement, pos: number, side: number): ReturnType<WidgetType["coordsAt"]> {
    return this.inner.coordsAt(dom, pos, side);
  }

  destroy(dom: HTMLElement): void {
    this.inner.destroy(dom);
  }
}

/**
 * Renders all widgets for the provided `visibleRanges`. The function traverses
 * the syntax tree within those ranges, makes sure that there is no selection
 * that overlaps the current node in any way, and afterwards calls
 * `shouldHandleNode` of each renderer of that node type. If that function
 * returns true, this indicates that there is a widget that should be rendered
 * in place of that node. To do so, the function then calls `createWidget`
 * which should return a widget that then gets rendered in place of the node,
 * or undefined if there was some condition that there should be no widget in
 * this node. The first renderer that returns a widget owns the node.
 *
 * @param   {EditorState}                   state          The current state of
 *                                                         the editor. Used to
 *                                                         traverse the syntax
 *                                                         tree.
 * @param   {{from: number, to: number}[]}  visibleRanges  The ranges to render.
 * @param   {RendererSpec[]}                specs          The renderers.
 * @param   {EditorView}                    visibleView    If given, the nodes
 *                                                         are those of the
 *                                                         view's visible
 *                                                         ranges.
 *
 * @return  {Range<Decoration>[]}                          The rendered
 *                                                         decorations, in
 *                                                         document order.
 */
function renderWidgets(
  state: EditorState,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  specs: readonly RendererSpec[],
  visibleView?: EditorView,
): Range<Decoration>[] {
  const widgets: Range<Decoration>[] = [];

  const includeAdjacent = previewConfiguration(state).previewModeShowSyntaxWhenCursorIsAdjacent;
  const specsByNodeType = new Map<string, RendererSpec[]>();
  for (const spec of specs) {
    for (const nodeType of spec.nodeTypes) {
      const candidates = specsByNodeType.get(nodeType);
      if (candidates === undefined) {
        specsByNodeType.set(nodeType, [spec]);
      } else {
        candidates.push(spec);
      }
    }
  }

  const handleNode = (node: SyntaxNodeRef): void => {
    const candidates = specsByNodeType.get(node.type.name);
    if (candidates === undefined) {
      return;
    }
    if (rangeInPreviewSuppression(state, node.from, node.to, includeAdjacent)) {
      return;
    }

    for (const spec of candidates) {
      if (!spec.shouldHandleNode(node)) {
        continue;
      }
      const renderedWidget = spec.createWidget(state, node);
      if (renderedWidget === undefined) {
        continue;
      }
      if (rowJoinOf(renderedWidget) !== null) {
        const join = rowJoinRange(state, node.from, node.to);
        if (join.from < node.from || join.to > node.to) {
          widgets.push(rowJoinMark.range(join.from, join.to));
        }
      }
      const widget = Decoration.replace({
        widget: new LineStyleResetWidget(renderedWidget, node.to - node.from),
        inclusive: false,
      });
      widgets.push(widget.range(node.from, node.to));
      break;
    }
  };

  if (visibleView !== undefined) {
    visitVisibleSyntaxNodes(visibleView, handleNode);
  } else {
    for (const { from, to } of visibleRanges) {
      syntaxTree(state).iterate({ from, to, enter: handleNode });
    }
  }

  return widgets;
}

/**
 * Call this function to define a plugin that renders inline widgets based on
 * syntax nodes. Note that this means that you should not use this plugin if you
 * plan to consume nodes that span linebreaks since this will throw an error.
 * Also, if you want to simply define additional syntax, please use the syntax
 * plugin.
 *
 * @param   {Function}    shouldHandleNode  A function that receives a syntax
 *                                          node and should return true if your
 *                                          plugin would like to handle it.
 * @param   {Function}    createWidget      A function that receives the editor
 *                                          state and the syntax node and should
 *                                          return a widget to render in its
 *                                          place.
 *
 * @return  {Extension}                     The view plugin plus the shared
 *                                          widget line-style reset theme
 */
export function renderInlineWidgets(
  nodeTypes: readonly string[],
  shouldHandleNode: (node: SyntaxNodeRef) => boolean,
  createWidget: (state: EditorState, node: SyntaxNodeRef) => WidgetType | undefined,
): Extension {
  const spec: RendererSpec = {
    nodeTypes: new Set(nodeTypes),
    shouldHandleNode,
    createWidget,
    inputsChanged: () => false,
  };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = Decoration.set(
          renderWidgets(view.state, view.visibleRanges, [spec], view),
          true,
        );
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          reviewSuppressionChanged(update)
        ) {
          this.decorations = Decoration.set(
            renderWidgets(update.view.state, update.view.visibleRanges, [spec], update.view),
            true,
          );
        }
      }
    },
    {
      decorations: (view) => view.decorations,
    },
  );

  return [widgetDecorationPrecedence(plugin), widgetTheme];
}

/**
 * One field holds the widgets of every block renderer. A transaction renders
 * again only the nodes that it can change: the nodes of the blocks that the
 * parser parsed again, and the nodes that touch the old or the new selection
 * or a review chunk. All widgets are rendered again only when a value changes
 * that a renderer declares through `inputsChanged`.
 */
const sharedBlockRendererField = incrementalNodeDecorations({
  decorate: (state, from, to) =>
    renderWidgets(state, [{ from, to }], state.facet(blockRendererFacet)),
  inputsChanged(before, after) {
    const specs = after.facet(blockRendererFacet);
    return (
      specs !== before.facet(blockRendererFacet) ||
      previewConfiguration(before).previewModeShowSyntaxWhenCursorIsAdjacent !==
        previewConfiguration(after).previewModeShowSyntaxWhenCursorIsAdjacent ||
      specs.some((spec) => spec.inputsChanged(before, after))
    );
  },
  changedReach: previewSuppressionChangedRanges,
});

/**
 * Call this function to define a plugin that renders inline and block widgets
 * based on syntax nodes. Use it for a widget that can span line breaks; a
 * widget that is guaranteed to be inline-only belongs to `renderInlineWidgets`.
 * Also, if you want to simply define additional syntax, please use the syntax
 * plugin.
 *
 * A widget that this function renders must not keep a document position: the
 * widget of a node outside a changed block is kept when the document changes.
 *
 * @param   {Function}    shouldHandleNode  A function that receives a syntax
 *                                          node and should return true if your
 *                                          plugin would like to handle it.
 * @param   {Function}    createWidget      A function that receives the editor
 *                                          state and the syntax node and should
 *                                          return a widget to render in its
 *                                          place.
 * @param   {Function}    inputsChanged     A function that receives two states
 *                                          and should return true if a state
 *                                          value that `createWidget` reads
 *                                          differs between them. Leave it out
 *                                          if `createWidget` reads only the
 *                                          node's text and the selection.
 *
 * @return  {Extension}                     The decoration StateField plus the
 *                                          shared widget line-style reset theme
 */
export function renderBlockWidgets(
  nodeTypes: readonly string[],
  shouldHandleNode: (node: SyntaxNodeRef) => boolean,
  createWidget: (state: EditorState, node: SyntaxNodeRef) => WidgetType | undefined,
  inputsChanged: RendererInputsChanged = () => false,
): Extension {
  return [
    blockRendererFacet.of({
      nodeTypes: new Set(nodeTypes),
      shouldHandleNode,
      createWidget,
      inputsChanged,
    }),
    widgetDecorationPrecedence(sharedBlockRendererField),
    widgetTheme,
  ];
}
