/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Mod-P workspace definition search red proofs (issue #1
 *                  Phase 3)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the pure ranking contract behind Mod-P workspace
 *                  definition search: fzf-backed fuzzy ranking over the
 *                  authored definition keys of the real multi-project
 *                  fixture workspace.
 *
 *                  The expected rankings were derived against the fzf npm
 *                  package (v0.5.2) as the oracle: for 'cob' both
 *                  consecutive-substring coble matches score 80 and the
 *                  scattered fuzzy match conj:borcherds-form scores 75, so
 *                  the specs assert result contents and the decisive
 *                  score-order boundaries rather than tie order.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import { searchWorkspaceDefinitions } from "source/common/modules/markdown-editor/util/reference-search";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { type ReferenceDefinition } from "source/types/common/references";

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const WORKSPACE_FILES = [
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectA", "Coble_Lattice_Table.md"),
  path.join("ProjectA", "Halphen_Surfaces.md"),
  "Standalone_Notes.md",
  path.join("ProjectB", "Other_Paper.md"),
];

/** Every definition of the fixture workspace, in workspace-feed order. */
function workspaceDefinitions(): ReferenceDefinition[] {
  return WORKSPACE_FILES.flatMap((relativePath) => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath);
    return extractReferences(documentPath, readFileSync(documentPath, "utf-8")).definitions;
  });
}

/** A stable identity for one definition (duplicates keep both documents). */
function identities(definitions: ReferenceDefinition[]): string[] {
  return definitions.map((definition) => `${definition.documentPath}::${definition.key}`);
}

describe("Mod-P workspace definition search ranks with fzf (issue #1 Phase 3)", function () {
  const workspace = workspaceDefinitions();

  it("reaches every workspace definition with the empty query", function () {
    // Fixture guard: the workspace must be representative (crossref families,
    // every theorem prefix, and cross-project duplicates) so the equality
    // below cannot pass vacuously.
    assert.ok(
      workspace.length >= 20,
      `the fixture workspace must stay representative (got ${workspace.length} definitions)`,
    );

    const results = searchWorkspaceDefinitions(workspace, "");

    assert.deepStrictEqual(identities(results).sort(), identities(workspace).sort());
  });

  it("ranks consecutive-substring matches above scattered fuzzy matches", function () {
    const keys = searchWorkspaceDefinitions(workspace, "cob").map((definition) => definition.key);

    // 'cob' matches exactly three workspace keys: the two consecutive
    // 'coble' substrings and the scattered c…o…b of conj:borcherds-form.
    assert.deepStrictEqual([...keys].sort(), [
      "conj:borcherds-form",
      "ex:coble-surface",
      "tbl:coble-lattices",
    ]);
    // Both consecutive matches outscore the scattered one (fzf: 80 vs 75).
    // Their tie order is not part of the contract.
    assert.deepStrictEqual(
      new Set(keys.slice(0, 2)),
      new Set(["ex:coble-surface", "tbl:coble-lattices"]),
    );
    assert.strictEqual(keys[2], "conj:borcherds-form");
  });

  it("finds every duplicate definition of a searched key across projects", function () {
    const results = searchWorkspaceDefinitions(workspace, "torelli");

    assert.deepStrictEqual(
      identities(results).sort(),
      [
        `${path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md")}::thm:torelli`,
        `${path.join(FIXTURE_ROOT, "ProjectB", "Other_Paper.md")}::thm:torelli`,
      ].sort(),
    );
  });

  it("resolves a scattered fuzzy query to the single matching key", function () {
    // 'kodemb' (kodaira…embedding) is a subsequence of exactly one workspace
    // key. NOTE: the phase plan's draft query 'klemb' is NOT a subsequence of
    // 'lem:kodaira:embedding' (no 'l' occurs after the 'k'), so no correct
    // fzf-backed implementation could ever satisfy it; 'kodemb' locks the
    // same scattered-fuzzy behavior with a satisfiable witness (verified
    // against fzf 0.5.2: single match, score 145).
    const results = searchWorkspaceDefinitions(workspace, "kodemb");

    assert.deepStrictEqual(
      results.map((definition) => [definition.key, definition.documentPath]),
      [["lem:kodaira:embedding", path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md")]],
    );
  });
});
