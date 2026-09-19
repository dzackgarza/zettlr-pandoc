/** Renderer-neutral block-shape lint for LaTeX environments in Markdown. */

import { markdownToAST } from "@common/modules/markdown-utils";
import type { ASTNode } from "@common/modules/markdown-utils/markdown-ast";
import { MATH_ENVIRONMENTS, wholeEnvironment } from "@common/util/math-delimiters";
import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import { FIGURE_ENVIRONMENTS } from "@common/util/tikz-source-blocks";

const OPEN_LINE_RE = /^\\begin\{([A-Za-z]+\*?)\}/gmu;

function childrenOf(node: ASTNode): ASTNode[] {
  if ("children" in node) {
    return node.children;
  }
  if ("items" in node) {
    return node.items;
  }
  if ("rows" in node) {
    return node.rows;
  }
  if ("cells" in node) {
    return node.cells;
  }
  return [];
}

function walkAST(node: ASTNode, visit: (node: ASTNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) {
    walkAST(child, visit);
  }
}

export function latexEnvironmentLintText(markdown: string): SourceLintDiagnostic[] {
  const diagnostics: SourceLintDiagnostic[] = [];
  walkAST(markdownToAST(markdown), (node) => {
    if (node.type !== "Generic" || node.name !== "Paragraph") {
      return;
    }
    const text = markdown.slice(node.from, node.to);
    if (wholeEnvironment(text) !== null) {
      return;
    }

    for (const match of text.matchAll(OPEN_LINE_RE)) {
      const environment = match[1];
      if (MATH_ENVIRONMENTS.has(environment)) {
        continue;
      }
      const absolute = node.from + match.index;
      const lineStart = markdown.lastIndexOf("\n", Math.max(0, absolute - 1)) + 1;
      const nextNewline = markdown.indexOf("\n", absolute);
      const lineEnd = nextNewline < 0 ? markdown.length : nextNewline;
      const drawsAFigure = FIGURE_ENVIRONMENTS.has(environment);
      diagnostics.push({
        from: lineStart,
        to: lineEnd,
        severity: drawsAFigure ? "error" : "warning",
        message: drawsAFigure
          ? `Zettlr could not recognize this \\begin{${environment}} as a complete raw block. ` +
            `Ensure it has a matching \\end{${environment}} and that the opener starts a line.`
          : `Zettlr could not recognize this \\begin{${environment}} as a complete raw block. ` +
            `Ensure it has a matching \\end{${environment}} and that the opener starts a line.`,
        source: "latex-environment-lint",
      });
    }
  });
  return diagnostics;
}
