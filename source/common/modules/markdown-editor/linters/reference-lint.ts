/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference Linter
 * CVM-Role:        Linter
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Diagnostics for workspace reference contradictions
 *                  (issue #1 Phase 4), following the md-lint linter()
 *                  archetype (./md-lint.ts).
 *
 *                  CONTRACT (locked by test/reference-lint.spec.ts):
 *
 *                  - referenceLintSource() is the linter source and is
 *                    exported for direct headless driving. The current
 *                    document's definitions and occurrences come from
 *                    workspaceReferencesField.snapshot; resolutions and the
 *                    citing index come from the same field. While the field
 *                    is null the linter reports nothing.
 *                  - DUPLICATE KEYS: every definition in this document whose
 *                    key resolves to 'duplicate' receives an ERROR at the
 *                    definition's authored id range whose message lists ALL
 *                    definition sites (every documentPath in the
 *                    resolution's definitions), never a silently selected
 *                    subset.
 *                  - MISSING REFERENCES: every occurrence in this document
 *                    whose key resolves to 'missing' receives a WARNING at
 *                    the occurrence's authored range naming the missing key.
 *                    The message MAY offer compatible existing keys as
 *                    replacement candidates, but every family-prefixed key
 *                    it mentions must be either the missing key itself or a
 *                    key actually defined in the workspace — the linter
 *                    never fabricates targets.
 *                  - CLASS/PREFIX MISMATCH: a theorem-div definition whose
 *                    div class and id prefix disagree (e.g. div class
 *                    `lemma` with id `thm:foo`) receives an ERROR at the
 *                    authored id range naming BOTH conflicting values and a
 *                    valid example (e.g. `#lem:foo` per the
 *                    theorem-family metadata). The linter never guesses
 *                    which side the author meant and never rewrites either.
 *                  - PROOF-DIV ID: an id attribute on a proof-like div
 *                    (which defines no target) receives an INFO diagnostic
 *                    at the authored id token explaining that proofs are
 *                    unreferenceable.
 *                  - MIXED CLUSTER ADVISORY: a citation cluster mixing
 *                    bibliography keys and supported-family reference keys
 *                    stays raw in the editor and receives a WARNING spanning
 *                    the whole authored cluster.
 *                  - NO AUTO-FIX: no diagnostic ever carries actions of any
 *                    kind.
 *
 * END HEADER
 */

import { type Diagnostic, linter } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { markdownToAST } from "@common/modules/markdown-utils";
import type { ASTNode } from "@common/modules/markdown-utils/markdown-ast";
import { locateAttribute } from "@common/pandoc-util/extract-references";
import { SEMANTIC_DIV_CLASSES } from "@common/pandoc-util/pandoc-div-model";
import {
  THEOREM_CLASS_TO_PREFIX as CLASS_TO_PREFIX,
  REFERENCEABLE_DIV_CLASSES,
} from "@common/util/pandoc-quick-reference";
import { type ReferenceFamily, referenceFamilyOf, referenceKeyParts } from "@dts/common/references";
import { availableCitationKeys } from "../autocomplete/citations";
import {
  type EditorWorkspaceReferences,
  workspaceReferencesField,
} from "../plugins/workspace-references-field";

const THEOREM_FAMILIES = new Set<string>(Object.values(CLASS_TO_PREFIX));

/**
 * The comparable remainder tokens of a key ('lem:kodaira:embedding' ->
 * ['kodaira', 'embedding']), used to offer existing keys as candidates.
 */
function remainderTokens(key: string): string[] {
  return (referenceKeyParts(key)?.remainder ?? key)
    .toLowerCase()
    .split(/[:_-]+/)
    .filter((token) => token !== "");
}

/**
 * Offers compatible existing keys as replacement candidates for a missing
 * key: same-family keys actually defined in the workspace that share at
 * least one remainder token. The linter never fabricates targets.
 *
 * @param   {string}                     missingKey  The missing key
 * @param   {ReferenceFamily}            family      The missing key's family
 * @param   {EditorWorkspaceReferences}  references  The workspace view
 *
 * @return  {string[]}                               Defined candidate keys
 */
function candidatesFor(
  missingKey: string,
  family: ReferenceFamily,
  references: EditorWorkspaceReferences,
): string[] {
  const tokens = new Set(remainderTokens(missingKey));
  const candidates: string[] = [];

  for (const [key, resolution] of references.resolutions) {
    if (key === missingKey || resolution.status === "missing") {
      continue; // Only keys actually defined somewhere qualify.
    }

    if (referenceFamilyOf(key) !== family) {
      continue;
    }

    if (remainderTokens(key).some((token) => tokens.has(token))) {
      candidates.push(key);
    }
  }

  return candidates.sort();
}

/**
 * Exact same-remainder definitions under another reference family. Unlike the
 * fuzzy same-family candidates above, these are evidence of a likely authored
 * namespace/type mismatch (`@eq:main` while `#fig:main` exists), so surface the
 * contradiction explicitly rather than reducing it to a generic missing key.
 */
function crossFamilyMatchesFor(
  missingKey: string,
  family: ReferenceFamily,
  references: EditorWorkspaceReferences,
): string[] {
  const missingParts = referenceKeyParts(missingKey);
  if (missingParts === undefined) {
    return [];
  }
  const remainder = missingParts.remainder.toLocaleLowerCase();
  const matches: string[] = [];

  for (const [key, resolution] of references.resolutions) {
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

/**
 * Walks every node of the given AST in document order.
 */
function walkAST(node: ASTNode, visit: (node: ASTNode) => void): void {
  visit(node);

  const children =
    "children" in node
      ? node.children
      : "items" in node
        ? node.items
        : "rows" in node
          ? node.rows
          : "cells" in node
            ? node.cells
            : [];

  for (const child of children) {
    walkAST(child, visit);
  }
}

/**
 * Collects the AST-derived diagnostics of the current buffer: ids on
 * proof-like divs and mixed bibliography/reference citation clusters.
 *
 * The id-token locator is the extractor's own exported locateAttribute
 * (review B6) — one authority, not a parallel copy. Its fail-loud contract
 * is kept deliberately: an inconsistent attribute block (parsed id absent
 * from the authored text) is a parser bug, and the resulting throw
 * propagates out of the lint source instead of silently dropping the
 * diagnostic — the condition is not reachable through authored input.
 */
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
  // The AST guarantees the key came from this citation. If its authored token
  // cannot be recovered, mark the citation rather than inventing coordinates.
  return { from: node.from, to: node.to };
}

function collectASTDiagnostics(
  markdown: string,
  diagnostics: Diagnostic[],
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
      const attributeRange = node.attributeRange ?? {
        from: node.from,
        to: Math.min(
          node.to,
          markdown.indexOf("\n", node.from) === -1 ? node.to : markdown.indexOf("\n", node.from),
        ),
      };

      if (referenceableClasses.length > 1) {
        diagnostics.push({
          from: attributeRange.from,
          to: attributeRange.to,
          severity: "error",
          message: `This div declares multiple referenceable theorem classes (${referenceableClasses.join(", ")}). Its theorem family and numbering semantics are ambiguous; keep exactly one referenceable theorem class.`,
          source: "reference-lint",
        });
      }

      if (referenceableClasses.length > 0 && proofClasses.length > 0) {
        diagnostics.push({
          from: attributeRange.from,
          to: attributeRange.to,
          severity: "error",
          message: `This div mixes referenceable theorem class "${referenceableClasses[0]}" with proof-like class "${proofClasses[0]}". Proofs are unnumbered/unreferenceable, so the two class semantics conflict.`,
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
          message: `The id "#${located.key}" on a proof div defines no reference target: proofs stay unnumbered and unreferenceable.`,
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
            message: `The id "#${located.key}" uses theorem family "${family}", but this div has no referenceable theorem class. Add the intended theorem class or use an id family matching the construct; otherwise theorem numbering/export semantics are undefined.`,
            source: "reference-lint",
          });
        }
      }
    } else if (node.type === "Citation") {
      const items = node.parsedCitation.items;
      const supported = items.filter((item) => referenceFamilyOf(item.id) !== undefined).length;
      if (supported > 0 && supported < items.length) {
        diagnostics.push({
          from: node.from,
          to: node.to,
          severity: "warning",
          message:
            "This cluster mixes bibliography citations with cross-references, so it stays raw: it renders neither as a citation nor as reference chips. Split it into separate clusters.",
          source: "reference-lint",
        });
      }

      if (citationKeys !== null) {
        const missingBibliographyKeys = new Set(
          items
            .map((item) => item.id)
            .filter((key) => referenceFamilyOf(key) === undefined && !citationKeys.has(key)),
        );
        for (const key of missingBibliographyKeys) {
          const range = citationKeyRange(markdown, node, key);
          diagnostics.push({
            ...range,
            severity: "error",
            message: `The bibliography citation "@${key}" does not exist in the bibliography configured for this document.`,
            source: "reference-lint",
          });
        }
      }
    }
  });
}

/**
 * Collects the snapshot-derived diagnostics: duplicate definitions, missing
 * occurrences, and theorem-div class/prefix mismatches.
 */
function collectSnapshotDiagnostics(
  references: EditorWorkspaceReferences,
  diagnostics: Diagnostic[],
): void {
  for (const definition of references.snapshot.definitions) {
    const resolution = references.resolutions.get(definition.key);

    if (resolution?.status === "duplicate") {
      const sites = resolution.definitions.map((site) => site.documentPath);
      diagnostics.push({
        from: definition.range.from,
        to: definition.range.to,
        severity: "error",
        message: `The reference key "${definition.key}" is defined more than once. Definition sites: ${sites.join(", ")}. Every key must be unique across the workspace.`,
        source: "reference-lint",
      });
    }

    if (definition.sourceKind === "theorem-div") {
      // The authored classes ride on the definition itself (review B6):
      // previewSource is a display excerpt and is never re-parsed here.
      const referenceableClasses = definition.classes.filter((divClass) =>
        REFERENCEABLE_DIV_CLASSES.includes(divClass.toLowerCase()),
      );
      const authoredClass =
        referenceableClasses.length > 0 ? referenceableClasses[0].toLowerCase() : undefined;
      const expectedPrefix =
        authoredClass !== undefined ? CLASS_TO_PREFIX[authoredClass] : undefined;
      if (
        authoredClass !== undefined &&
        expectedPrefix !== undefined &&
        definition.family !== expectedPrefix
      ) {
        const parts = referenceKeyParts(definition.key);
        const separator = parts?.separator ?? ":";
        const remainder = parts?.remainder ?? definition.key;
        const example = `#${expectedPrefix}${separator}${remainder}`;
        diagnostics.push({
          from: definition.range.from,
          to: definition.range.to,
          severity: "error",
          message: `The div class "${authoredClass}" conflicts with the id "#${definition.key}": a ${authoredClass} div uses the "${expectedPrefix}" family, e.g. "${example}". Change one side to match the other.`,
          source: "reference-lint",
        });
      }
    }
  }

  for (const occurrence of references.snapshot.occurrences) {
    const resolution = references.resolutions.get(occurrence.key);
    if (resolution?.status !== "missing") {
      continue;
    }

    const candidates = candidatesFor(occurrence.key, occurrence.family, references);
    const crossFamily = crossFamilyMatchesFor(occurrence.key, occurrence.family, references);
    const suffix =
      crossFamily.length > 0
        ? ` A definition with the same label exists under another reference family: ${crossFamily.map((key) => `@${key}`).join(", ")}. Check the reference type.`
        : candidates.length > 0
          ? ` Did you mean ${candidates.join(", ")}?`
          : "";
    diagnostics.push({
      from: occurrence.range.from,
      to: occurrence.range.to,
      severity: "warning",
      message: `The reference "@${occurrence.key}" is not defined anywhere in the workspace.${suffix}`,
      source: "reference-lint",
    });
  }
}

/**
 * The diagnostic source for workspace reference lint: the specs drive this
 * function directly against a real EditorView.
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {Promise<Diagnostic[]>}  The reference diagnostics
 */
export async function referenceLintSource(view: EditorView): Promise<Diagnostic[]> {
  const references = view.state.field(workspaceReferencesField, false) ?? null;
  if (references === null) {
    return []; // No workspace view yet: the linter reports nothing.
  }

  const diagnostics: Diagnostic[] = [];
  collectSnapshotDiagnostics(references, diagnostics);
  collectASTDiagnostics(view.state.doc.toString(), diagnostics, availableCitationKeys(view.state));

  return diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
}

export const referenceLint = linter(referenceLintSource);
