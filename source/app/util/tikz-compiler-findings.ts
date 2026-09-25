import { tikzCompilerLogHeadline } from "@common/util/tikz-compiler-log";
import { type TikzSourceBlock, tikzSourceBlocksInMarkdown } from "@common/util/tikz-source-blocks";
import type { TikzRenderRequest, TikzRenderResult } from "./tikz-render";

export interface TikzCompilerFinding {
  from: number;
  to: number;
  message: string;
}

function lineRange(block: TikzSourceBlock, lineNumber: number): { from: number; to: number } {
  const index = Math.max(0, Math.min(block.sourceLineRanges.length - 1, lineNumber - 1));
  return block.sourceLineRanges[index];
}

/**
 * Run the TikZ compiler and return compiler facts only.
 *
 * This is deliberately not a linter: Flowmark's tikz/compile-error extension
 * rule owns whether and how these compiler findings become lint diagnostics.
 */
export async function collectTikzCompilerFindings(
  markdown: string,
  docPath: string,
  render: (request: TikzRenderRequest) => Promise<TikzRenderResult>,
): Promise<TikzCompilerFinding[]> {
  const findings: TikzCompilerFinding[] = [];
  for (const block of tikzSourceBlocksInMarkdown(markdown)) {
    const result = await render({
      source: block.source,
      kind: block.kind,
      language: block.language,
      docPath,
    });
    if (result.ok || result.kind !== "compile-error") {
      continue;
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        findings.push({
          ...lineRange(block, error.line),
          message: "TikZ compilation failed: " + error.message +
            (error.sourceLine === "" ? "" : " — " + error.sourceLine),
        });
      }
    } else {
      const headline = tikzCompilerLogHeadline(result.log);
      findings.push({
        from: block.sourceFrom,
        to: Math.max(block.sourceFrom, block.sourceTo),
        message:
          headline === "" ? "TikZ compilation failed." : "TikZ compilation failed: " + headline,
      });
    }
  }
  return findings.sort((a, b) => a.from - b.from || a.to - b.to);
}
