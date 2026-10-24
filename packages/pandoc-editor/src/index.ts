import { markdownKeymap } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import markdownParser, { type MarkdownParserConfig } from "./parser/markdown-parser";
import { backgroundLayers } from "./plugins/code-background";
import { softwrapVisualIndent } from "./plugins/visual-indent";
import { renderBlockquotes } from "./renderers/render-blockquotes";
import { renderCode } from "./renderers/render-code";
import { renderEmphasis } from "./renderers/render-emphasis";
import { renderHeadings } from "./renderers/render-headings";
import { renderHorizontalRules } from "./renderers/render-hr";
import { renderLinks } from "./renderers/render-links";
import { type MathHost, mathHost, renderMath } from "./renderers/render-math";
import { renderTasks } from "./renderers/render-tasks";
import { mainThemes, themeBerlinLight } from "./theme";
import { markdownSyntaxHighlighter } from "./theme/syntax";

export { default as markdownParser } from "./parser/markdown-parser";
export { previewConfig } from "./util/configuration";
export { previewSuppression } from "./util/range-in-preview-suppression";

export interface MarkdownRendering {
  renderingMode: "preview" | "raw";
  renderLinks: boolean;
  renderTasks: boolean;
  renderHeadings: boolean;
  renderEmphasis: boolean;
  renderHorizontalRules: boolean;
}

export const defaultRendering: MarkdownRendering = {
  renderingMode: "preview",
  renderLinks: true,
  renderTasks: true,
  renderHeadings: true,
  renderEmphasis: true,
  renderHorizontalRules: true,
};

/** The standard renderers shared by document editors and embedded fields. */
export function markdownRenderers(config: MarkdownRendering = defaultRendering): Extension[] {
  const extensions: Extension[] = [renderCode];
  if (config.renderingMode === "raw") return extensions;
  if (config.renderLinks) extensions.push(renderLinks);
  if (config.renderTasks) extensions.push(renderTasks);
  if (config.renderHeadings) extensions.push(renderHeadings);
  if (config.renderEmphasis) extensions.push(renderEmphasis, renderBlockquotes);
  if (config.renderHorizontalRules) extensions.push(renderHorizontalRules);
  return extensions;
}

/** Host services contribute renderers; parsing and editor presentation stay shared. */
export function markdownEditor(
  options: {
    language?: MarkdownParserConfig;
    renderers?: Extension;
    theme?: Extension;
    math?: MathHost;
  } = {},
): Extension[] {
  return [
    markdownParser(options.language),
    markdownSyntaxHighlighter(),
    mainThemes,
    options.theme ?? themeBerlinLight,
    EditorView.lineWrapping,
    keymap.of(markdownKeymap),
    backgroundLayers,
    softwrapVisualIndent,
    options.renderers ?? markdownRenderers(),
    ...(options.math ? [mathHost.of(options.math), renderMath] : []),
  ];
}
