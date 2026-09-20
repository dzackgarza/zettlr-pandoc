/** Renderer-neutral workspace reference/citation diagnostics. */

import { markdownToAST } from "@common/modules/markdown-utils";
import type { ASTNode } from "@common/modules/markdown-utils/markdown-ast";
import { locateAttribute } from "@common/pandoc-util/extract-references";
import { SEMANTIC_DIV_CLASSES } from "@common/pandoc-util/pandoc-div-model";
import {
  THEOREM_CLASS_TO_PREFIX as CLASS_TO_PREFIX,
  REFERENCEABLE_DIV_CLASSES,
} from "@common/util/pandoc-quick-reference";
import type { SourceLintDiagnostic } from "@common/util/source-lint-diagnostic";
import type {
  DocumentReferenceSnapshot,
  ReferenceFamily,
  Resolution,
} from "@dts/common/references";
import { referenceFamilyOf, referenceKeyParts } from "@dts/common/references";

export interface ReferenceLintContext {
  snapshot: DocumentReferenceSnapshot;
  resolutions: ReadonlyMap<string, Resolution>;
  citationKeys: ReadonlySet<string> | null;
}

const THEOREM_FAMILIES = new Set<string>(Object.values(CLASS_TO_PREFIX));

function remainderTokens(key: string): string[] {
  return (referenceKeyParts(key)?.remainder ?? key)
    .toLowerCase()
    .split(/[:_-]+/u)
    .filter((token) => token !== "");
}

function candidatesFor(
  missingKey: string,
  family: ReferenceFamily,
  context: ReferenceLintContext,
): string[] {
  const tokens = new Set(remainderTokens(missingKey));
  const candidates: string[] = [];
  for (const [key, resolution] of context.resolutions) {
    if (
      key === missingKey ||
      resolution.status === "missing" ||
      referenceFamilyOf(key) !== family
    ) {
      continue;
    }
    if (remainderTokens(key).some((token) => tokens.has(token))) {
      candidates.push(key);
    }
  }
  return candidates.sort();
}

function crossFamilyMatchesFor(
  missingKey: string,
  family: ReferenceFamily,
  context: ReferenceLintContext,
): string[] {
  const missingParts = referenceKeyParts(missingKey);
  if (missingParts === undefined) {
    return [];
  }
  const remainder = missingParts.remainder.toLocaleLowerCase();
  const matches: string[] = [];
  for (const [key, resolution] of context.resolutions) {
    if (resolution.status === "missing") {
      continue;
    }
    const candidateFamily = referenceFamilyOf(key);
    const parts = referenceKeyParts(key);
    if (
      candidateFamily !== undefined &&
      candidateFamily !== family &&
      parts !== undefined &&
      parts.remainder.toLocaleLowerCase() === remainder
    ) {
      matches.push(key);
    }
  }
  return matches.sort();
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

function citationKeyRange(
  markdown: string,
  node: ASTNode & { type: "Citation" },
  key: string,
): { from: number; to: number } {
  const source = markdown.slice(node.from, node.to);
  const braced = `@{${key}}`;
  const ordinary = `@${key}`;
  const relative = source.indexOf(braced);
  if (relative >= 0) {
    return { from: node.from + relative, to: node.from + relative + braced.length };
  }
  const plainRelative = source.indexOf(ordinary);
  if (plainRelative >= 0) {
    return { from: node.from + plainRelative, to: node.from + plainRelative + ordinary.length };
  }
  return { from: node.from, to: node.to };
}

function collectASTDiagnostics(
  markdown: string,
  diagnostics: SourceLintDiagnostic[],
  citationKeys: ReadonlySet<string> | null,
): void {
  walkAST(markdownToAST(markdown), (node) => {
    if (node.type === "PandocDiv") {
      const classAttribute = node.attributes.class ?? node.attributes.classes ?? [];
      const classes = Array.isArray(classAttribute) ? classAttribute : [classAttribute];
      const normalizedClasses = classes.map((divClass) => divClass.toLowerCase());
      const referenceableClasses = normalizedClasses.filter((divClass) =>
        REFERENCEABLE_DIV_CLASSES.includes(divClass),
      );
      const proofClasses = normalizedClasses.filter(
        (divClass) => SEMANTIC_DIV_CLASSES[divClass] === "proof",
      );
      const newline = markdown.indexOf("\n", node.from);
      const attributeRange = node.attributeRange ?? {
        from: node.from,
        to: Math.min(node.to, newline === -1 ? node.to : newline),
      };

      if (referenceableClasses.length > 1) {
        diagnostics.push({
          ...attributeRange,
          severity: "error",
          message: `This block has multiple theorem classes (${referenceableClasses.join(", ")}). Keep one; only one numbering and reference type can apply.`,
          source: "reference-lint",
        });
      }
      if (referenceableClasses.length > 0 && proofClasses.length > 0) {
        diagnostics.push({
          ...attributeRange,
          severity: "error",
          message: `This block is both "${referenceableClasses[0]}" and "${proofClasses[0]}". "${referenceableClasses[0]}" is numbered; "${proofClasses[0]}" is not. Choose one class.`,
          source: "reference-lint",
        });
      }

      const openLineEnd = markdown.indexOf("\n", node.from);
      const openLine = markdown.slice(
        node.from,
        openLineEnd === -1 || openLineEnd > node.to ? node.to : openLineEnd,
      );
      const brace = openLine.indexOf("{");
      if (brace === -1) {
        return;
      }
      const located = locateAttribute(openLine.slice(brace), node.from + brace);
      if (located === undefined) {
        return;
      }
      const locatedClasses = located.attributes.classes ?? [];
      const isProofLike = locatedClasses.some(
        (divClass) => SEMANTIC_DIV_CLASSES[divClass.toLowerCase()] === "proof",
      );
      if (isProofLike) {
        diagnostics.push({
          from: located.range.from,
          to: located.range.to,
          severity: "info",
          message: `Proof blocks are unnumbered, so "#${located.key}" does not create a reference target here.`,
          source: "reference-lint",
        });
      } else {
        const family = referenceFamilyOf(located.key);
        if (
          family !== undefined &&
          THEOREM_FAMILIES.has(family) &&
          referenceableClasses.length === 0
        ) {
          diagnostics.push({
            from: located.range.from,
            to: located.range.to,
            severity: "error",
            message: `The ID "#${located.key}" starts with "${family}", but this block has no theorem class. Change the ID or add the intended theorem class.`,
            source: "reference-lint",
          });
        }
      }
      return;
    }

    if (node.type !== "Citation") {
      return;
    }
    const items = node.parsedCitation.items;
    const supported = items.filter((item) => referenceFamilyOf(item.id) !== undefined).length;
    if (supported > 0 && supported < items.length) {
      diagnostics.push({
        from: node.from,
        to: node.to,
        severity: "warning",
        message:
          "This citation contains both bibliography entries and cross-references. Put them in separate [...] groups.",
        source: "reference-lint",
      });
    }
    if (citationKeys === null) {
      return;
    }
    const missingBibliographyKeys = new Set(
      items
        .map((item) => item.id)
        .filter((key) => referenceFamilyOf(key) === undefined && !citationKeys.has(key)),
    );
    for (const key of missingBibliographyKeys) {
      diagnostics.push({
        ...citationKeyRange(markdown, node, key),
        severity: "error",
        message: `Bibliography entry "@${key}" was not found.`,
        source: "reference-lint",
      });
    }
  });
}

function collectSnapshotDiagnostics(
  context: ReferenceLintContext,
  diagnostics: SourceLintDiagnostic[],
): void {
  for (const definition of context.snapshot.definitions) {
    const resolution = context.resolutions.get(definition.key);
    if (resolution?.status === "duplicate") {
      const sites = resolution.definitions.map((site) => site.documentPath);
      diagnostics.push({
        from: definition.range.from,
        to: definition.range.to,
        severity: "error",
        message: `Reference "${definition.key}" is defined in more than one place: ${sites.join(", ")}.`,
        source: "reference-lint",
      });
    }
    if (definition.sourceKind !== "theorem-div") {
      continue;
    }
    const referenceableClasses = definition.classes.filter((divClass) =>
      REFERENCEABLE_DIV_CLASSES.includes(divClass.toLowerCase()),
    );
    const authoredClass = referenceableClasses[0]?.toLowerCase();
    const expectedPrefix = authoredClass === undefined ? undefined : CLASS_TO_PREFIX[authoredClass];
    if (
      authoredClass === undefined ||
      expectedPrefix === undefined ||
      definition.family === expectedPrefix
    ) {
      continue;
    }
    const parts = referenceKeyParts(definition.key);
    const separator = parts?.separator ?? ":";
    const remainder = parts?.remainder ?? definition.key;
    diagnostics.push({
      from: definition.range.from,
      to: definition.range.to,
      severity: "error",
      message: `This is a "${authoredClass}" block, but its ID is "#${definition.key}". Use "#${expectedPrefix}${separator}${remainder}" here, or change the block class.`,
      source: "reference-lint",
    });
  }

  for (const occurrence of context.snapshot.occurrences) {
    const resolution = context.resolutions.get(occurrence.key);
    if (resolution?.status !== "missing") {
      continue;
    }
    const candidates = candidatesFor(occurrence.key, occurrence.family, context);
    const crossFamily = crossFamilyMatchesFor(occurrence.key, occurrence.family, context);
    const suffix =
      crossFamily.length > 0
        ? ` A matching definition exists as ${crossFamily.map((key) => `@${key}`).join(", ")}. Did you use the wrong reference type?`
        : candidates.length > 0
          ? ` Did you mean ${candidates.join(", ")}?`
          : "";
    diagnostics.push({
      from: occurrence.range.from,
      to: occurrence.range.to,
      severity: "warning",
      message: `Reference "@${occurrence.key}" is not defined in the workspace.${suffix}`,
      source: "reference-lint",
    });
  }
}

export function referenceLintText(
  markdown: string,
  context: ReferenceLintContext,
): SourceLintDiagnostic[] {
  const diagnostics: SourceLintDiagnostic[] = [];
  collectSnapshotDiagnostics(context, diagnostics);
  collectASTDiagnostics(markdown, diagnostics, context.citationKeys);
  return diagnostics.sort(
    (a, b) => a.from - b.from || a.to - b.to || a.message.localeCompare(b.message),
  );
}
