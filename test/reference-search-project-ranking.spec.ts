/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Mod-P current-Project ranking specs (issue #1, review A3 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the US-16 ranking contract onto the Mod-P search
 *                  core: given the active document and the visible Project
 *                  roots, current-Project definitions (same file or listed
 *                  in the active Project root) rank before every other
 *                  workspace definition, while fzf score order is preserved
 *                  WITHIN each group. The no-context call keeps the Phase 3
 *                  contract locked by test/reference-fzf-search.spec.ts
 *                  byte-identically.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import { searchWorkspaceDefinitions } from "source/common/modules/markdown-editor/util/reference-search";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { computeProjectReferenceStatus } from "source/common/pandoc-util/project-reference-status";
import { type ProjectRootSpec, type ReferenceDefinition } from "source/types/common/references";

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
// DELIBERATELY fed with the non-current documents FIRST: a broken
// implementation that ignores the context and returns the feed (or plain
// fzf tie) order must fail the grouping assertions below.
const WORKSPACE_FILES = [
  "Standalone_Notes.md",
  path.join("ProjectB", "Other_Paper.md"),
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectA", "Coble_Lattice_Table.md"),
  path.join("ProjectA", "Halphen_Surfaces.md"),
];

const PROJECT_ROOTS: ProjectRootSpec[] = [
  {
    rootPath: path.join(FIXTURE_ROOT, "ProjectA"),
    files: ["Theorems.md", "Coble_Lattice_Table.md", "Halphen_Surfaces.md"],
  },
  {
    rootPath: path.join(FIXTURE_ROOT, "ProjectB"),
    files: ["Other_Paper.md"],
  },
];

const ACTIVE_DOCUMENT = path.join(FIXTURE_ROOT, "ProjectA", "Halphen_Surfaces.md");

/** Every definition of the fixture workspace, in workspace-feed order. */
function workspaceDefinitions(): ReferenceDefinition[] {
  return WORKSPACE_FILES.flatMap((relativePath) => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath);
    return extractReferences(documentPath, readFileSync(documentPath, "utf-8")).definitions;
  });
}

/** Whether a definition belongs to the current Project of the active doc. */
function isCurrent(definition: ReferenceDefinition): boolean {
  const status = computeProjectReferenceStatus(
    definition.documentPath,
    ACTIVE_DOCUMENT,
    PROJECT_ROOTS,
  );
  return status === "same-file" || status === "in-active-project";
}

/** A stable identity for one definition (duplicates keep both documents). */
function identities(definitions: ReferenceDefinition[]): string[] {
  return definitions.map((definition) => `${definition.documentPath}::${definition.key}`);
}

describe("Mod-P current-Project-first ranking (review A3)", function () {
  const workspace = workspaceDefinitions();
  const context = { activeDocumentPath: ACTIVE_DOCUMENT, projectRoots: PROJECT_ROOTS };

  it("ranks the current-Project duplicate before the other-Project duplicate", function () {
    // thm:torelli is defined in ProjectA/Theorems.md AND ProjectB/
    // Other_Paper.md with identical fzf scores: only the Project grouping
    // can order them deterministically.
    const results = searchWorkspaceDefinitions(workspace, "torelli", context);

    assert.deepStrictEqual(
      identities(results),
      [
        `${path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md")}::thm:torelli`,
        `${path.join(FIXTURE_ROOT, "ProjectB", "Other_Paper.md")}::thm:torelli`,
      ],
      "the active-Project definition must rank first, the other-Project duplicate after it",
    );
  });

  it("lists every current-Project definition before every other definition on the empty query", function () {
    const results = searchWorkspaceDefinitions(workspace, "", context);

    // The grouping must never gate: the empty query still reaches EVERY
    // workspace definition.
    assert.deepStrictEqual(identities(results).sort(), identities(workspace).sort());

    const currentCount = workspace.filter(isCurrent).length;
    assert.ok(
      currentCount >= 5,
      `the fixture must stay representative (got ${currentCount} current-Project definitions)`,
    );
    assert.ok(
      workspace.length - currentCount >= 3,
      "the fixture must keep other-Project and standalone definitions to rank after the current Project",
    );

    assert.deepStrictEqual(
      results.map(isCurrent),
      [
        ...Array.from({ length: currentCount }, () => true),
        ...Array.from({ length: workspace.length - currentCount }, () => false),
      ],
      "every current-Project definition must precede every non-current definition",
    );
  });

  it("preserves the fzf order within each group", function () {
    const ungrouped = searchWorkspaceDefinitions(workspace, "cob");
    const grouped = searchWorkspaceDefinitions(workspace, "cob", context);

    assert.deepStrictEqual(
      identities(grouped).sort(),
      identities(ungrouped).sort(),
      "grouping must never add or drop matches",
    );
    assert.deepStrictEqual(
      identities(grouped.filter(isCurrent)),
      identities(ungrouped.filter(isCurrent)),
      "the current group must keep the fzf score order",
    );
    assert.deepStrictEqual(
      identities(grouped.filter((definition) => !isCurrent(definition))),
      identities(ungrouped.filter((definition) => !isCurrent(definition))),
      "the marked rest must keep the fzf score order",
    );
  });

  it("same-file definitions count as current for a standalone active document", function () {
    const standalonePath = path.join(FIXTURE_ROOT, "Standalone_Notes.md");
    // Feed the standalone document LAST so feed order cannot satisfy the
    // same-file-first claim by accident.
    const reordered = [
      ...workspace.filter((definition) => definition.documentPath !== standalonePath),
      ...workspace.filter((definition) => definition.documentPath === standalonePath),
    ];
    const results = searchWorkspaceDefinitions(reordered, "", {
      activeDocumentPath: standalonePath,
      projectRoots: PROJECT_ROOTS,
    });

    const currentIdentities = identities(
      results.filter((_definition, index) => {
        const status = computeProjectReferenceStatus(
          results[index].documentPath,
          standalonePath,
          PROJECT_ROOTS,
        );
        return status === "same-file" || status === "in-active-project";
      }),
    );
    const standaloneDefinitions = workspace.filter(
      (definition) => definition.documentPath === standalonePath,
    );
    assert.ok(
      standaloneDefinitions.length > 0,
      "the fixture standalone document must define at least one target",
    );
    assert.deepStrictEqual(
      identities(results.slice(0, standaloneDefinitions.length)),
      currentIdentities,
      "a standalone active document ranks its own definitions first",
    );
  });
});
