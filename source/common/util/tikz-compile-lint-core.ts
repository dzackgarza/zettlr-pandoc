import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import { tikzCompilerLogHeadline } from "@common/util/tikz-compiler-log";
import { type TikzSourceBlock, tikzSourceBlocksInMarkdown } from "@common/util/tikz-source-blocks";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";

function lineRange(block: TikzSourceBlock, lineNumber: number): { from: number; to: number } {
  const lines = block.source.split("\n");
  const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  let relative = 0;
  for (let line = 0; line < index; line += 1) {
    relative += lines[line].length + 1;
  }
  return {
    from: block.sourceFrom + relative,
    to: block.sourceFrom + relative + lines[index].length,
  };
}

export async function tikzCompileLintText(
  markdown: string,
  docPath: string,
  render: (request: TikzRenderRequest) => Promise<TikzRenderResult>,
): Promise<SourceLintDiagnostic[]> {
  const diagnostics: SourceLintDiagnostic[] = [];
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
        diagnostics.push({
          ...lineRange(block, error.line),
          severity: "error",
          message: `TikZ compilation failed: ${error.message}${error.sourceLine === "" ? "" : ` — ${error.sourceLine}`}`,
          source: "tikz-compile",
          rule: "tikz/compile-error",
        });
      }
    } else {
      const headline = tikzCompilerLogHeadline(result.log);
      diagnostics.push({
        from: block.sourceFrom,
        to: Math.max(block.sourceFrom, block.sourceTo),
        severity: "error",
        message:
          headline === "" ? "TikZ compilation failed." : `TikZ compilation failed: ${headline}`,
        source: "tikz-compile",
        rule: "tikz/compile-error",
      });
    }
  }
  return diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
}
