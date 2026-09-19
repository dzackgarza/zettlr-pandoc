/** Renderer-neutral scholarly/math lint rules. */

import { markdownToAST } from "@common/modules/markdown-utils";
import type { ASTNode } from "@common/modules/markdown-utils/markdown-ast";
import { mathFromCodeNode } from "@common/util/math-delimiters";
import type { MathJaxMacro } from "@common/util/mathjax-config";
import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import { texCommandDeclarations } from "@common/util/tex-command-declarations";

interface SourceRegion {
  from: number;
  to: number;
  source: string;
}

export type ScholarlyTexResourceKind = "input" | "graphics";

export interface ScholarlyTexResourceProbe {
  id: number;
  kind: ScholarlyTexResourceKind;
  path: string;
}

export interface ScholarlyTexResourceProbeRequest {
  sourcePath: string;
  projectRoots: string[];
  graphicRoots: string[];
  resources: ScholarlyTexResourceProbe[];
}

export interface ScholarlyTexResourceProbeResult {
  id: number;
  checkable: boolean;
  resolvedPath?: string;
}

export interface ScholarlyLintOptions {
  knownCommands: ReadonlySet<string>;
  configuredMacros: ReadonlyMap<string, MathJaxMacro>;
  sourcePath?: string;
  projectRoots?: string[];
  resolveResources?: (
    request: ScholarlyTexResourceProbeRequest,
  ) => Promise<ScholarlyTexResourceProbeResult[]>;
}

const CONTROL_WORD_RE = /(?<!\\)\\([A-Za-z@]+)/gu;

const NOTATION_VARIANTS = [
  ["\\epsilon", "\\varepsilon"],
  ["\\phi", "\\varphi"],
  ["\\theta", "\\vartheta"],
  ["\\rho", "\\varrho"],
  ["\\sigma", "\\varsigma"],
  ["\\kappa", "\\varkappa"],
] as const;

const AUTHORIAL_RESIDUE = [
  { pattern: /\b(?:TODO|FIXME|XXX)\b/gu, description: "unfinished author note" },
  { pattern: /\[\s*citation needed\s*\]/giu, description: "citation placeholder" },
  { pattern: /\bCITE(?:ME)?\b/gu, description: "citation placeholder" },
  { pattern: /\?\?\?/gu, description: "unresolved placeholder" },
  { pattern: /\\todo\b/gu, description: "TeX todo marker" },
] as const;

const TEX_INPUT_RESOURCE_RE = /(?<!\\)\\(?:input|include)\s*\{(?<path>[^{}\n]+)\}/gu;
const TEX_GRAPHICS_RESOURCE_RE =
  /(?<!\\)\\includegraphics(?:\s*\[[^\]\n]*\])?\s*\{(?<path>[^{}\n]+)\}/gu;
const TEX_GRAPHICSPATH_RE = /(?<!\\)\\graphicspath\s*\{(?<paths>(?:\s*\{[^{}\n]*\}\s*)+)\}/gu;
const TEX_GRAPHICSPATH_ENTRY_RE = /\{(?<path>[^{}\n]*)\}/gu;

interface AuthoredTexResource {
  id: number;
  kind: ScholarlyTexResourceKind;
  path: string;
  from: number;
  to: number;
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

function sourceOffsetForCodeNode(markdown: string, node: ASTNode & { source: string }): number {
  const raw = markdown.slice(node.from, node.to);
  const relative = raw.indexOf(node.source);
  return relative < 0 ? node.from : node.from + relative;
}

function collectDocumentRegions(markdown: string): {
  math: SourceRegion[];
  texIgnored: Array<{ from: number; to: number }>;
  prose: SourceRegion[];
} {
  const math: SourceRegion[] = [];
  const texIgnored: Array<{ from: number; to: number }> = [];
  const prose: SourceRegion[] = [];

  walkAST(markdownToAST(markdown), (node) => {
    if (node.type === "InlineCode" || node.type === "FencedCode") {
      const parsedMath = mathFromCodeNode(node.info, node.source);
      if (parsedMath === null) {
        texIgnored.push({ from: node.from, to: node.to });
      } else {
        const from = sourceOffsetForCodeNode(markdown, node);
        math.push({ from, to: from + node.source.length, source: node.source });
      }
      return;
    }

    if (node.type === "Text" || node.type === "Comment") {
      if (node.type === "Comment") {
        texIgnored.push({ from: node.from, to: node.to });
      }
      prose.push({ from: node.from, to: node.to, source: markdown.slice(node.from, node.to) });
    } else if (node.type === "YAMLFrontmatter") {
      texIgnored.push({ from: node.from, to: node.to });
    }
  });

  return { math, texIgnored, prose };
}

function overlaps(range: { from: number; to: number }, offset: number): boolean {
  return offset >= range.from && offset < range.to;
}

function localMacroNames(
  markdown: string,
  ignored: Array<{ from: number; to: number }>,
): ReadonlySet<string> {
  const chars = markdown.split("");
  for (const range of ignored) {
    chars.fill(" ", range.from, range.to);
  }
  return new Set(texCommandDeclarations(chars.join("")));
}

function unknownMacroDiagnostics(
  regions: SourceRegion[],
  known: ReadonlySet<string>,
  local: ReadonlySet<string>,
): SourceLintDiagnostic[] {
  const diagnostics: SourceLintDiagnostic[] = [];
  for (const region of regions) {
    const seen = new Set<number>();
    for (const match of region.source.matchAll(CONTROL_WORD_RE)) {
      const command = `\\${match[1]}`;
      if (known.has(command) || local.has(command) || seen.has(match.index)) {
        continue;
      }
      seen.add(match.index);
      diagnostics.push({
        from: region.from + match.index,
        to: region.from + match.index + match[0].length,
        severity: "warning",
        message: `${command} is not present in the editor's configured LaTeX/MathJax command catalogue or the document's local macro declarations. If it is supplied by the export preamble only, add it to the canonical authoring macro projection; otherwise this is an undefined macro.`,
        source: "scholarly-lint",
      });
    }
  }
  return diagnostics;
}

function commandOccurrences(regions: SourceRegion[], command: string): number[] {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`${escaped}(?![A-Za-z@])`, "gu");
  const offsets: number[] = [];
  for (const region of regions) {
    for (const match of region.source.matchAll(pattern)) {
      offsets.push(region.from + match.index);
    }
  }
  return offsets;
}

function notationDiagnostics(regions: SourceRegion[]): SourceLintDiagnostic[] {
  const diagnostics: SourceLintDiagnostic[] = [];
  for (const [first, second] of NOTATION_VARIANTS) {
    const firstOffsets = commandOccurrences(regions, first);
    const secondOffsets = commandOccurrences(regions, second);
    if (
      firstOffsets.length === 0 ||
      secondOffsets.length === 0 ||
      firstOffsets.length === secondOffsets.length
    ) {
      continue;
    }
    const [majority, majorityCount, minority, minorityOffsets] =
      firstOffsets.length > secondOffsets.length
        ? ([first, firstOffsets.length, second, secondOffsets] as const)
        : ([second, secondOffsets.length, first, firstOffsets] as const);
    if (majorityCount < 2) {
      continue;
    }
    for (const from of minorityOffsets) {
      diagnostics.push({
        from,
        to: from + minority.length,
        severity: "info",
        message: `Notation is inconsistent in this document: ${majority} is the established form (${majorityCount} uses), while ${minority} also appears.`,
        source: "scholarly-lint",
      });
    }
  }
  return diagnostics;
}

function configuredMacroExpansionDiagnostics(
  regions: SourceRegion[],
  configuredMacros: ReadonlyMap<string, MathJaxMacro>,
): SourceLintDiagnostic[] {
  const diagnostics: SourceLintDiagnostic[] = [];
  const aliases = new Map<string, string[]>();
  for (const [macro, definition] of configuredMacros) {
    if (typeof definition !== "string") {
      continue;
    }
    const expansion = definition.trim();
    if (expansion.length < 4 || expansion === macro) {
      continue;
    }
    const existing = aliases.get(expansion);
    if (existing === undefined) {
      aliases.set(expansion, [macro]);
    } else {
      existing.push(macro);
    }
  }
  for (const region of regions) {
    for (const [expansion, macros] of aliases) {
      if (macros.length !== 1) {
        continue;
      }
      let offset = region.source.indexOf(expansion);
      while (offset >= 0) {
        diagnostics.push({
          from: region.from + offset,
          to: region.from + offset + expansion.length,
          severity: "info",
          message: `The canonical authoring macro ${macros[0]} expands exactly to ${expansion}; use the project macro so notation stays consistent with the shared vocabulary.`,
          source: "scholarly-lint",
        });
        offset = region.source.indexOf(expansion, offset + expansion.length);
      }
    }
  }
  return diagnostics;
}

function residueDiagnostics(regions: SourceRegion[]): SourceLintDiagnostic[] {
  const diagnostics: SourceLintDiagnostic[] = [];
  for (const region of regions) {
    for (const residue of AUTHORIAL_RESIDUE) {
      const pattern = new RegExp(residue.pattern.source, residue.pattern.flags);
      for (const match of region.source.matchAll(pattern)) {
        diagnostics.push({
          from: region.from + match.index,
          to: region.from + match.index + match[0].length,
          severity: "info",
          message: `Authorial residue: ${residue.description} ${JSON.stringify(match[0])} remains in the document.`,
          source: "scholarly-lint",
        });
      }
    }
  }
  return diagnostics;
}

function collectTexResources(
  markdown: string,
  ignored: Array<{ from: number; to: number }>,
): { resources: AuthoredTexResource[]; graphicRoots: string[] } {
  const resources: AuthoredTexResource[] = [];
  const graphicRoots: string[] = [];
  let id = 0;
  for (const [pattern, kind] of [
    [TEX_INPUT_RESOURCE_RE, "input"],
    [TEX_GRAPHICS_RESOURCE_RE, "graphics"],
  ] as const) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    for (const match of markdown.matchAll(scanner)) {
      if (ignored.some((range) => overlaps(range, match.index))) {
        continue;
      }
      const authoredPath = match.groups?.path;
      if (authoredPath === undefined) {
        continue;
      }
      const relative = match[0].indexOf(authoredPath);
      resources.push({
        id: id++,
        kind,
        path: authoredPath,
        from: match.index + relative,
        to: match.index + relative + authoredPath.length,
      });
    }
  }
  for (const match of markdown.matchAll(TEX_GRAPHICSPATH_RE)) {
    if (ignored.some((range) => overlaps(range, match.index))) {
      continue;
    }
    const paths = match.groups?.paths;
    if (paths === undefined) {
      continue;
    }
    for (const entry of paths.matchAll(TEX_GRAPHICSPATH_ENTRY_RE)) {
      const root = entry.groups?.path?.trim();
      if (root !== undefined && root !== "") {
        graphicRoots.push(root);
      }
    }
  }
  return { resources, graphicRoots };
}

async function texResourceDiagnostics(
  markdown: string,
  ignored: Array<{ from: number; to: number }>,
  options: ScholarlyLintOptions,
): Promise<SourceLintDiagnostic[]> {
  const { resources, graphicRoots } = collectTexResources(markdown, ignored);
  const sourcePath = options.sourcePath ?? "";
  if (resources.length === 0 || sourcePath === "" || options.resolveResources === undefined) {
    return [];
  }
  const results = await options.resolveResources({
    sourcePath,
    projectRoots: options.projectRoots ?? [],
    graphicRoots,
    resources: resources.map(({ id, kind, path }) => ({ id, kind, path })),
  });
  const byId = new Map(results.map((result) => [result.id, result]));
  const diagnostics: SourceLintDiagnostic[] = [];
  for (const resource of resources) {
    const result = byId.get(resource.id);
    if (result === undefined || !result.checkable || result.resolvedPath !== undefined) {
      continue;
    }
    diagnostics.push({
      from: resource.from,
      to: resource.to,
      severity: "warning",
      message: `TeX ${resource.kind === "input" ? "input/include" : "graphics"} resource ${JSON.stringify(resource.path)} is not resolvable through the source/Project directory or the configured TeX search roots.`,
      source: "scholarly-lint",
    });
  }
  return diagnostics;
}

export async function scholarlyLintText(
  markdown: string,
  options: ScholarlyLintOptions,
): Promise<SourceLintDiagnostic[]> {
  const regions = collectDocumentRegions(markdown);
  const localMacros = localMacroNames(markdown, regions.texIgnored);
  const resourceDiagnostics = await texResourceDiagnostics(markdown, regions.texIgnored, options);
  return [
    ...unknownMacroDiagnostics(regions.math, options.knownCommands, localMacros),
    ...notationDiagnostics(regions.math),
    ...configuredMacroExpansionDiagnostics(regions.math, options.configuredMacros),
    ...residueDiagnostics(regions.prose),
    ...resourceDiagnostics,
  ].sort((a, b) => a.from - b.from || a.to - b.to || a.message.localeCompare(b.message));
}
