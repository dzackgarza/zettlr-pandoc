/** Main-process context producer + Flowmark lint adapter for API/workspace consumers. */

import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import type { WikilinkIndex } from "@common/util/wikilink-resolution";
import path from "node:path";
import { lintMarkdownText } from "./flowmark-lint";
import type { TikzRenderConfig } from "tikz-workbench/src/tikz-render";
import { buildFlowmarkLintContext, type FlowmarkReferenceContext } from "./flowmark-lint-context";

export interface DocumentLintSharedContext {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  macroSources: readonly string[];
  wikilinks?: WikilinkIndex;
  tikzRenderConfig: TikzRenderConfig;
  /** `editor.lint.flowmark.timeoutMs` from the app config. */
  flowmarkLintTimeoutMs: number;
}

export interface CreateDocumentLintContextOptions {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  wikilinks?: WikilinkIndex;
  tikzRenderConfig: TikzRenderConfig;
  flowmarkLintTimeoutMs: number;
}

/**
 * One diagnostic as every consumer reads it: the source range as offsets and
 * as 1-based line/column positions, and the Flowmark rule or failure kind
 * behind it.
 */
export type DocumentLintDiagnostic = SourceLintDiagnostic & {
  rule: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export interface DocumentLintOutcome {
  diagnostics: DocumentLintDiagnostic[];
  /** False when Flowmark itself failed; the diagnostics then report that failure. */
  complete: boolean;
}

/** Omitting `bibliographies` lets Flowmark use the document's own `bibliography` metadata. */
export interface DocumentLintDocumentOptions {
  bibliographies?: string[];
  projectRoots?: string[];
  references?: FlowmarkReferenceContext;
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

function positionForOffset(text: string, offset: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: bounded - lineStart + 1 };
}

function positioned(
  text: string,
  diagnostic: SourceLintDiagnostic & { rule: string },
): DocumentLintDiagnostic {
  const start = positionForOffset(text, diagnostic.from);
  const end = positionForOffset(text, diagnostic.to);
  return {
    ...diagnostic,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
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
): Promise<DocumentLintOutcome> {
  const diagnostics: DocumentLintDiagnostic[] = [];
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
      diagnostics.push(positioned(text, {
        from: offsetForLineColumn(text, diagnostic.line, diagnostic.column),
        to: offsetForLineColumn(text, diagnostic.end_line, diagnostic.end_column),
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: "Flowmark",
        rule: diagnostic.rule,
        suggestions: diagnostic.suggestions,
        ...(diagnostic.fix === null ? {} : { fix: diagnostic.fix }),
        data: diagnostic.data,
      }));
    }
  } else {
    diagnostics.push(positioned(text, {
      from: 0,
      to: Math.min(1, text.length),
      severity: "error",
      message: `Flowmark could not lint this document: ${flowmark.message}`,
      source: "Flowmark",
      rule: flowmark.kind,
    }));
  }

  return {
    complete: flowmark.ok,
    diagnostics: diagnostics.sort(
      (a, b) =>
        a.from - b.from ||
        a.to - b.to ||
        a.severity.localeCompare(b.severity) ||
        a.rule.localeCompare(b.rule),
    ),
  };
}
