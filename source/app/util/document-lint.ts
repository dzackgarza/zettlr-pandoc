/** Main-process document lint composition for API/workspace consumers. */

import { extractReferences } from "@common/pandoc-util/extract-references";
import { resolveWorkspace } from "@common/pandoc-util/resolve-references";
import { latexEnvironmentLintText } from "@common/util/latex-environment-lint-core";
import type { MathJaxMacro } from "@common/util/mathjax-config";
import { referenceLintText } from "@common/util/reference-lint-core";
import { scholarlyLintText } from "@common/util/scholarly-lint-core";
import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import { standardTexControlWords } from "@common/util/standard-tex-control-words";
import { tikzCompileLintText } from "@common/util/tikz-compile-lint-core";
import type { DocumentReferenceSnapshot, Resolution } from "@dts/common/references";
import type { WorkspaceReferenceState } from "@providers/references/reference-index";
import { lintMarkdownText } from "./flowmark-lint";
import { loadCanonicalMathJaxMacros, loadCanonicalTexMacroCommands } from "./load-mathjax-macros";
import { resolveTexResources } from "./tex-resource-resolver";
import { renderTikz, type TikzRenderConfig } from "./tikz-render";

export interface DocumentLintSharedContext {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  knownCommands: ReadonlySet<string>;
  configuredMacros: ReadonlyMap<string, MathJaxMacro>;
  referenceState?: WorkspaceReferenceState;
  citationKeys: ReadonlySet<string> | null;
  tikzRenderConfig: TikzRenderConfig;
}

export interface CreateDocumentLintContextOptions {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  referenceState?: WorkspaceReferenceState;
  citationKeys?: ReadonlySet<string> | null;
  tikzRenderConfig: TikzRenderConfig;
}

export interface DocumentLintDocumentOptions {
  citationKeys?: ReadonlySet<string> | null;
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

function exactReferenceContext(
  documentPath: string,
  text: string,
  referenceState: WorkspaceReferenceState | undefined,
):
  | { snapshot: DocumentReferenceSnapshot; resolutions: ReadonlyMap<string, Resolution> }
  | undefined {
  if (referenceState === undefined) {
    return undefined;
  }
  const snapshot = extractReferences(documentPath, text);
  const snapshots = referenceState.snapshots
    .filter((candidate) => candidate.documentPath !== documentPath)
    .concat(snapshot);
  return { snapshot, resolutions: resolveWorkspace(snapshots) };
}

export async function createDocumentLintContext(
  options: CreateDocumentLintContextOptions,
): Promise<DocumentLintSharedContext> {
  const [mathJaxMacros, compilerCommands] = await Promise.all([
    loadCanonicalMathJaxMacros(options.homeDirectory),
    loadCanonicalTexMacroCommands(options.homeDirectory),
  ]);
  const knownCommands = new Set(standardTexControlWords());
  for (const name of Object.keys(mathJaxMacros)) {
    knownCommands.add(`\\${name}`);
  }
  for (const command of compilerCommands) {
    knownCommands.add(command);
  }
  const configuredMacros = new Map<string, MathJaxMacro>(
    Object.entries(mathJaxMacros).map(([name, definition]) => [`\\${name}`, definition]),
  );
  return {
    ...options,
    knownCommands,
    configuredMacros,
    citationKeys: options.citationKeys ?? null,
  };
}

export async function lintDocumentText(
  text: string,
  documentPath: string,
  context: DocumentLintSharedContext,
  options: DocumentLintDocumentOptions = {},
): Promise<SourceLintDiagnostic[]> {
  const citationKeys = options.citationKeys ?? context.citationKeys;
  const diagnostics: SourceLintDiagnostic[] = [];

  const flowmark = await lintMarkdownText(text, { sourcePath: documentPath });
  if (flowmark.ok) {
    for (const diagnostic of flowmark.diagnostics) {
      diagnostics.push({
        from: offsetForLineColumn(text, diagnostic.line, diagnostic.column),
        to: offsetForLineColumn(text, diagnostic.end_line, diagnostic.end_column),
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: "flowmark",
        rule: diagnostic.rule,
      });
    }
  } else {
    diagnostics.push({
      from: 0,
      to: Math.min(1, text.length),
      severity: "error",
      message: `Flowmark linter unavailable: ${flowmark.message}`,
      source: "flowmark-lint",
      rule: flowmark.kind,
    });
  }

  diagnostics.push(
    ...latexEnvironmentLintText(text),
    ...(await scholarlyLintText(text, {
      knownCommands: context.knownCommands,
      configuredMacros: context.configuredMacros,
      sourcePath: documentPath,
      projectRoots: options.projectRoots ?? [],
      resolveResources: async (request) =>
        await resolveTexResources(request, context.homeDirectory, context.env),
    })),
  );

  const references = exactReferenceContext(documentPath, text, context.referenceState);
  if (references !== undefined) {
    diagnostics.push(
      ...referenceLintText(text, {
        ...references,
        citationKeys,
      }),
    );
  }

  diagnostics.push(
    ...(await tikzCompileLintText(
      text,
      documentPath,
      async (request) => await renderTikz(request, context.tikzRenderConfig),
    )),
  );

  return diagnostics.sort(
    (a, b) =>
      a.from - b.from ||
      a.to - b.to ||
      a.severity.localeCompare(b.severity) ||
      a.message.localeCompare(b.message),
  );
}
