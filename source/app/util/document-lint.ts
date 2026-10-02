/** Main-process context producer + Flowmark lint adapter for API/workspace consumers. */

import path from "node:path";
import { Text } from "@codemirror/state";
import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import type { WikilinkIndex } from "@common/util/wikilink-resolution";
import type { TikzRenderConfig } from "tikz-workbench/src/tikz-render";
import { lintMarkdownText } from "./flowmark-lint";
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

// The document as a CodeMirror `Text`: a line lookup by number or by offset is
// a tree walk, so the cost of positioning the diagnostics of a document does
// not grow with the length of the document times their count.
function offsetForLineColumn(doc: Text, line: number, column: number): number {
  const target = doc.line(Math.max(1, Math.min(doc.lines, Math.trunc(line))));
  return Math.min(target.to, target.from + Math.max(0, Math.trunc(column) - 1));
}

function positionForOffset(doc: Text, offset: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(bounded);
  return { line: line.number, column: bounded - line.from + 1 };
}

function positioned(
  doc: Text,
  diagnostic: SourceLintDiagnostic & { rule: string },
): DocumentLintDiagnostic {
  const start = positionForOffset(doc, diagnostic.from);
  const end = positionForOffset(doc, diagnostic.to);
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
  const flowmarkContext = await buildFlowmarkLintContext(text, documentPath, context, options);

  const flowmark = await lintMarkdownText(text, {
    command: "flowmark-lint",
    sourcePath: documentPath,
    context: flowmarkContext,
    timeoutMs: context.flowmarkLintTimeoutMs,
  });
  const doc = Text.of(text.split("\n"));
  if (flowmark.ok) {
    for (const diagnostic of flowmark.diagnostics) {
      diagnostics.push(
        positioned(doc, {
          from: offsetForLineColumn(doc, diagnostic.line, diagnostic.column),
          to: offsetForLineColumn(doc, diagnostic.end_line, diagnostic.end_column),
          severity: diagnostic.severity,
          message: diagnostic.message,
          source: "Flowmark",
          rule: diagnostic.rule,
          suggestions: diagnostic.suggestions,
          ...(diagnostic.fix === null ? {} : { fix: diagnostic.fix }),
          data: diagnostic.data,
        }),
      );
    }
  } else {
    diagnostics.push(
      positioned(doc, {
        from: 0,
        to: Math.min(1, text.length),
        severity: "error",
        message: `Flowmark could not lint this document: ${flowmark.message}`,
        source: "Flowmark",
        rule: flowmark.kind,
      }),
    );
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
