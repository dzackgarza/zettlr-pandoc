import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { backgroundLayers } from "source/common/modules/markdown-editor/plugins/code-background";
import { footnoteBackground } from "source/common/modules/markdown-editor/plugins/footnote-background";
import { tagClasses } from "source/common/modules/markdown-editor/plugins/tag-classes";
import { softwrapVisualIndent } from "source/common/modules/markdown-editor/plugins/visual-indent";
import { renderers } from "source/common/modules/markdown-editor/renderers";
import { defaultLight, editorTheme } from "source/common/modules/markdown-editor/theme/editor";
import {
  configField,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";

declare global {
  interface Window {
    captureReady: Promise<void>;
    fastScrollCoverage: () => {
      scrollTop: number;
      clientHeight: number;
      visibleLineCount: number;
      renderedLineCount: number;
      renderedAbovePx: number;
      renderedBelowPx: number;
      viewportFrom: number;
      viewportTo: number;
    };
  }
}

function longDocument(): string {
  const blocks: string[] = [];
  for (let index = 0; index < 900; index += 1) {
    blocks.push(
      `## Section ${index}`,
      "",
      `Paragraph ${index} with *emphasis*, [a link](https://example.com/${index}), inline \`code\`, and #tag-${index % 17}.`,
      "",
      `> Quoted line ${index} with **strong text** and another [link](https://example.org/${index}).`,
      "",
      `::: {.theorem #thm:${index}}`,
      `Theorem body ${index} with highlighted ==text== and \`symbol_${index}\`.`,
      ":::",
      "",
      `[^note-${index}]: Footnote body ${index} with enough text to exercise line decoration.`,
      "",
    );
  }
  return blocks.join("\n");
}

async function mount(): Promise<void> {
  const host = document.querySelector<HTMLElement>("#editor");
  if (host === null) {throw new Error("Fast-scroll visual host is missing");}

  const config = getDefaultConfig();
  config.metadata.path = "/tmp/fast-scroll.md";
  config.renderMath = false;
  config.renderImages = false;
  config.renderCitations = false;
  config.renderTables = false;
  config.renderIframes = false;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: longDocument(),
      extensions: [
        editorTheme,
        defaultLight,
        EditorView.lineWrapping,
        markdownParser(),
        configField.init(() => config),
        renderers(config),
        backgroundLayers,
        footnoteBackground,
        tagClasses(),
        softwrapVisualIndent,
      ],
    }),
  });

  window.fastScrollCoverage = () => {
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const lineRects = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).map(
      (line) => line.getBoundingClientRect(),
    );
    const visibleLineCount = lineRects.filter((rect) => {
      return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
    }).length;
    const viewportTop = view.lineBlockAt(view.viewport.from).top;
    const viewportBottom = view.lineBlockAt(view.viewport.to).bottom;
    return {
      scrollTop: view.scrollDOM.scrollTop,
      clientHeight: view.scrollDOM.clientHeight,
      visibleLineCount,
      renderedLineCount: lineRects.length,
      renderedAbovePx: view.scrollDOM.scrollTop - viewportTop,
      renderedBelowPx: viewportBottom - (view.scrollDOM.scrollTop + view.scrollDOM.clientHeight),
      viewportFrom: view.viewport.from,
      viewportTo: view.viewport.to,
    };
  };

  // Start well away from either document boundary so both overscan directions
  // are measurable after large wheel jumps.
  view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight * 0.35;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

window.captureReady = mount();
