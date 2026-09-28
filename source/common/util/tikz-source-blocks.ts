/**
 * Renderer-neutral TikZ source recognition. The CodeMirror renderer and the
 * main-process lint engine both consume these rules so they cannot disagree
 * about which authored blocks are compilable figures.
 */

import { markdownToAST } from "@common/modules/markdown-utils";
import type { ASTNode } from "@common/modules/markdown-utils/markdown-ast";
import {
  contiguousSourceLineRanges,
  rawTikzEnvironment,
  type TikzSourceBlock,
} from "tikz-workbench/src/source-block";

export const INPUT_TIKZ_RE = /^\s*\\input\s*\{\s*([^}]+?\.(?:tikz|tikzcd))\s*\}\s*$/u;

export function rawTikzInput(paragraphText: string): string | null {
  const match = INPUT_TIKZ_RE.exec(paragraphText);
  return match !== null ? match[1] : null;
}

export function tikzLanguageForFenceInfo(infoText: string): "tikz" | "tikzcd" | null {
  const trimmed = infoText.trim();
  const isTikz = trimmed === "tikz" || /^\{[^}]*\.tikz[\s}]/u.test(trimmed);
  const isTikzCd = trimmed === "tikzcd" || /^\{[^}]*\.tikzcd[\s}]/u.test(trimmed);
  if (!isTikz && !isTikzCd) {
    return null;
  }
  return isTikzCd ? "tikzcd" : "tikz";
}

export function usesOwnedTikzTemplate(block: TikzSourceBlock): boolean {
  if (block.kind === "raw") {
    return true;
  }
  const declaresDocumentClass = /\\documentclass(?:\[[^\]]*\])?\s*\{/u.test(block.source);
  const hasDocumentBody = /\\begin\s*\{document\}/u.test(block.source);
  return !(declaresDocumentClass && hasDocumentBody);
}

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

function fencedSourceOffset(markdown: string, node: ASTNode & { source: string }): number {
  const raw = markdown.slice(node.from, node.to);
  const relative = raw.indexOf(node.source);
  return relative < 0 ? node.from : node.from + relative;
}

/** Every supported TikZ block in source order. */
export function tikzSourceBlocksInMarkdown(markdown: string): TikzSourceBlock[] {
  const blocks: TikzSourceBlock[] = [];
  walkAST(markdownToAST(markdown), (node) => {
    if (node.type === "FencedCode") {
      const language = tikzLanguageForFenceInfo(node.info);
      if (language === null) {
        return;
      }
      const sourceFrom = fencedSourceOffset(markdown, node);
      blocks.push({
        from: node.from,
        to: node.to,
        sourceFrom,
        sourceTo: sourceFrom + node.source.length,
        source: node.source,
        sourceLineRanges: contiguousSourceLineRanges(node.source, sourceFrom),
        kind: "fence",
        language,
      });
      return;
    }

    if (node.type === "RawBlock") {
      const environment = rawTikzEnvironment(node.source);
      const inputPath = rawTikzInput(node.source);
      if (environment === null && inputPath === null) {
        return;
      }
      blocks.push({
        from: node.from,
        to: node.to,
        sourceFrom: node.from,
        sourceTo: node.to,
        source: node.source,
        sourceLineRanges: node.sourceLineRanges,
        kind: "raw",
        language:
          environment === "tikzcd" || inputPath?.endsWith(".tikzcd") === true ? "tikzcd" : "tikz",
      });
      return;
    }
  });
  return blocks.sort((a, b) => a.from - b.from || a.to - b.to);
}
