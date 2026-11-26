import { foldedRanges, syntaxTree } from "@codemirror/language";
import { type Range, RangeSet, StateEffect } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { SpaceWidget } from "../renderers/render-emphasis";

export const VISUAL_INDENT_EXEMPT_CLASS = "visual-indent-exempt";

const visualIndentExemptTheme = EditorView.baseTheme({
  [`.${VISUAL_INDENT_EXEMPT_CLASS} .cm-line`]: {
    paddingLeft: "revert !important",
    textIndent: "revert !important",
  },
});

const BASE_PADDING = 6;
const indentationMeasured = StateEffect.define<null>();

const WHITESPACE_RE = /^([ \t]+)/;

const LISTMARK_RE = /^(\s*(?:[+*-](?:\s\[[x\s]\])?|\d+\.)\s)/;

const QUOTEMARK_RE = /^((?:[ ]{0,3}\>)+[ ]?)/;

const tabReplaceDeco = new MatchDecorator({
  regexp: /\t/g,
  boundary: /[^\t]/g,
  decoration: (_match, view, _pos) =>
    Decoration.replace({ widget: new SpaceWidget(view.state.tabSize) }),
});

function render(
  view: EditorView,
  measurements: Map<string, number>,
  measured: () => void,
): RangeSet<Decoration> {
  const ranges: Array<Range<Decoration>> = [];
  const requestedDoc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;

      const node = syntaxTree(view.state).resolve(line.from, 1);
      if (node.name === "CodeText" && node.parent?.name !== "IndentedCode") {
        continue;
      }

      const match =
        LISTMARK_RE.exec(line.text) ??
        QUOTEMARK_RE.exec(line.text) ??
        WHITESPACE_RE.exec(line.text);
      if (match === null) {
        continue;
      }

      const columnLineTextStart = match[1].length;

      const measurementKey = line.text
        .slice(0, columnLineTextStart)
        .replace("\t", " ".repeat(view.state.tabSize));

      view.requestMeasure({
        read(view) {
          if (view.state.doc !== requestedDoc) {
            return false;
          }
          const pos = line.from + columnLineTextStart;

          const folded = foldedRanges(view.state).iter(pos);
          while (folded.value) {
            if (pos >= folded.from && pos <= folded.to) {
              return false;
            }
            folded.next();
          }

          const base = view.contentDOM.getBoundingClientRect().left;
          const coords = view.coordsAtPos(pos);
          if (coords === null) {
            return false;
          }
          const indent = coords.left - base;
          if (measurements.get(measurementKey) === indent) return false;
          measurements.set(measurementKey, indent);
          return true;
        },
        write(changed) {
          if (changed) measured();
        },
        key: measurementKey,
      });

      const indent = measurements.get(measurementKey);
      if (indent !== undefined) {
        const deco = Decoration.line({
          attributes: {
            style: `text-indent: -${indent - BASE_PADDING}px; padding-left: ${indent}px;`,
          },
        });
        ranges.push(deco.range(line.from));
      }
    }
  }

  return Decoration.set(ranges, true);
}

const softwrapVisualIndentPlugin = ViewPlugin.define(
  (view) => {
    const measurements = new Map<string, number>();
    let active = true;
    let queued = false;
    const measured = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) view.dispatch({ effects: indentationMeasured.of(null) });
      });
    };
    return {
      decorations: render(view, measurements, measured),
      tabDecorations: tabReplaceDeco.createDeco(view),
      measurements,

      update(u: ViewUpdate) {
        this.decorations = render(u.view, this.measurements, measured);
        this.tabDecorations = tabReplaceDeco.updateDeco(u, this.tabDecorations);
      },
      destroy() {
        active = false;
      },
    };
  },
  {
    decorations(value) {
      return RangeSet.join([value.decorations, value.tabDecorations]);
    },
  },
);

export const softwrapVisualIndent = [softwrapVisualIndentPlugin, visualIndentExemptTheme];
