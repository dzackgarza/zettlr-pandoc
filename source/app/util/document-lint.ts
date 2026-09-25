/** Main-process context producer + Flowmark lint adapter for API/workspace consumers. */

import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import type { WorkspaceReferenceState } from "@providers/references/reference-index";
import path from "node:path";
import { lintMarkdownText } from "./flowmark-lint";
import type { TikzRenderConfig } from "./tikz-render";
import { buildFlowmarkLintContext } from "./flowmark-lint-context";

export interface DocumentLintSharedContext {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  macroSources: readonly string[];
  referenceState?: WorkspaceReferenceState;
  tikzRenderConfig: TikzRenderConfig;
  /** `editor.lint.flowmark.timeoutMs` from the app config. */
  flowmarkLintTimeoutMs: number;
}

export interface CreateDocumentLintContextOptions {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  referenceState?: WorkspaceReferenceState;
  tikzRenderConfig: TikzRenderConfig;
  flowmarkLintTimeoutMs: number;
}

/** Every diagnostic this adapter emits names the Flowmark rule or failure kind behind it. */
type RuledSourceLintDiagnostic = SourceLintDiagnostic & { rule: string };

/** Omitting `bibliographies` lets Flowmark use the document's own `bibliography` metadata. */
export interface DocumentLintDocumentOptions {
  bibliographies?: string[];
  projectRoots?: string[];
}

function offsetForLineColumn(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.trunc(line) - 1));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1;
  }
  return Math.min(offset + lines[lineIndex].length, offset + Math.max(0, Math.trunc(column) - 1));
}

export async function createDocumentLintContext(
  options: CreateDocumentLintContextOptions,
): Promise<DocumentLintSharedContext> {
  return {
    ...options,
    macroSources: [
      path.join(options.homeDirectory, ".pandoc", "styles", "macros"),
      path.join(options.homeDirectory, ".pandoc", "templates", "css", "mathjax-macros.json"),
    ],
  };
}

export async function lintDocumentText(
  text: string,
  documentPath: string,
  context: DocumentLintSharedContext,
  options: DocumentLintDocumentOptions = {},
): Promise<SourceLintDiagnostic[]> {
  const diagnostics: RuledSourceLintDiagnostic[] = [];
  const flowmarkContext = await buildFlowmarkLintContext(
    text,
    documentPath,
    context,
    options,
  );

  const flowmark = await lintMarkdownText(text, {
    sourcePath: documentPath,
    context: flowmarkContext,
    timeoutMs: context.flowmarkLintTimeoutMs,
  });
  if (flowmark.ok) {
    for (const diagnostic of flowmark.diagnostics) {
      diagnostics.push({
        from: offsetForLineColumn(text, diagnostic.line, diagnostic.column),
        to: offsetForLineColumn(text, diagnostic.end_line, diagnostic.end_column),
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: "Flowmark",
        rule: diagnostic.rule,
        suggestions: diagnostic.suggestions,
        data: diagnostic.data,
      });
    }
  } else {
    diagnostics.push({
      from: 0,
      to: Math.min(1, text.length),
      severity: "error",
      message: `Flowmark could not lint this document: ${flowmark.message}`,
      source: "Flowmark",
      rule: flowmark.kind,
    });
  }

  return diagnostics.sort(
    (a, b) =>
      a.from - b.from ||
      a.to - b.to ||
      a.severity.localeCompare(b.severity) ||
      a.rule.localeCompare(b.rule),
  );
}
