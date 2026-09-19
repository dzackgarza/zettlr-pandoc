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
import { type EditorState, type Extension, Facet, type Range, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type SyntaxNodeRef } from "@lezer/common";
import { configField } from "../util/configuration";
import {
  rangeInPreviewSuppression,
  reviewSuppressionChanged,
} from "../util/range-in-preview-suppression";
import { visitVisibleSyntaxNodes } from "../util/visible-syntax-nodes";

interface RendererSpec {
  nodeTypes: ReadonlySet<string>;
  shouldHandleNode: (node: SyntaxNodeRef) => boolean;
  createWidget: (state: EditorState, node: SyntaxNodeRef) => WidgetType | undefined;
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

const widgetLineStyleResetTheme = EditorView.baseTheme({
  [`.${WIDGET_LINE_STYLE_RESET_CLASS}`]: {
    textIndent: "0",
  },
});

/**
 * Wraps a renderer's widget so its DOM is stamped with the line-style reset
 * class. Everything else — identity, events, geometry, lifecycle — delegates
 * to the wrapped widget.
 */
class LineStyleResetWidget extends WidgetType {
  constructor(readonly inner: WidgetType) {
    super();
  }

  eq(other: LineStyleResetWidget): boolean {
    return other.inner.constructor === this.inner.constructor && this.inner.eq(other.inner);
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = this.inner.toDOM(view);
    dom.classList.add(WIDGET_LINE_STYLE_RESET_CLASS);
    return dom;
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
      dom.classList.add(WIDGET_LINE_STYLE_RESET_CLASS);
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
 * `shouldHandleNode`. If that function returns true, this indicates that there
 * is a widget that should be rendered in place of that node. To do so, the
 * function then calls `createWidget` which should return a widget that then
 * gets rendered in place of the node, or undefined if there was some condition
 * that there should be no widget in this node.
 *
 * @param   {EditorState}                   state             The current state
 *                                                            of the editor.
 *                                                            Used to traverse
 *                                                            the syntax tree.
 * @param   {{from: number, to: number}[]}  visibleRanges     The ranges to
 *                                                            render. If an
 *                                                            empty array is
 *                                                            provided, this
 *                                                            means to
 *                                                            (re)render the
 *                                                            full document.
 * @param   {Function}                      shouldHandleNode  A function that
 *                                                            should check the
 *                                                            provided node and
 *                                                            return true if the
 *                                                            node represents a
 *                                                            widget.
 * @param   {Function}                      createWidget      A function that
 *                                                            should create the
 *                                                            widget for that
 *                                                            node.
 *
 * @return  {DecorationSet}                                   A set of rendered
 *                                                            decorations.
 */
function renderWidgets(
  state: EditorState,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  specs: readonly RendererSpec[],
  visibleView?: EditorView,
): DecorationSet {
  const widgets: Range<Decoration>[] = [];

  if (visibleRanges.length === 0) {
    visibleRanges = [{ from: 0, to: state.doc.length }];
  }

  const includeAdjacent =
    state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true;
  const specsByNodeType = new Map<string, RendererSpec[]>();
  for (const spec of specs) {
    for (const nodeType of spec.nodeTypes) {
      const candidates = specsByNodeType.get(nodeType) ?? [];
      candidates.push(spec);
      specsByNodeType.set(nodeType, candidates);
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
      const widget = Decoration.replace({
        widget: new LineStyleResetWidget(renderedWidget),
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

  return Decoration.set(widgets);
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
  };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = renderWidgets(view.state, view.visibleRanges, [spec], view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          reviewSuppressionChanged(update)
        ) {
          this.decorations = renderWidgets(
            update.view.state,
            update.view.visibleRanges,
            [spec],
            update.view,
          );
        }
      }
    },
    {
      decorations: (view) => view.decorations,
    },
  );

  return [plugin, widgetLineStyleResetTheme];
}

/**
 * Call this function to define a plugin that renders inline and block widgets
 * based on syntax nodes. Note that this function is in general slower as it
 * will (re)parse the full document, so if you would like to render widgets that
 * are guaranteed to be inline-only, please use `renderInlineWidgets` instead.
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
 * @return  {Extension}                     The decoration StateField plus the
 *                                          shared widget line-style reset theme
 */
const sharedBlockRendererField = StateField.define<DecorationSet>({
  create(state: EditorState) {
    return renderWidgets(state, [], state.facet(blockRendererFacet));
  },
  update(_oldDecoSet, transaction) {
    return renderWidgets(transaction.state, [], transaction.state.facet(blockRendererFacet));
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function renderBlockWidgets(
  nodeTypes: readonly string[],
  shouldHandleNode: (node: SyntaxNodeRef) => boolean,
  createWidget: (state: EditorState, node: SyntaxNodeRef) => WidgetType | undefined,
): Extension {
  return [
    blockRendererFacet.of({
      nodeTypes: new Set(nodeTypes),
      shouldHandleNode,
      createWidget,
    }),
    sharedBlockRendererField,
    widgetLineStyleResetTheme,
  ];
}
