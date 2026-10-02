import assert from "assert";
import { readFileSync } from "fs";
import path from "path";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { resolveWorkspace } from "source/common/pandoc-util/resolve-references";
import type { DocumentReferenceSnapshot, Resolution } from "source/types/common/references";

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");

const WORKSPACE_FILES = [
  path.join("ProjectA", "Halphen_Surfaces.md"),
  path.join("ProjectA", "Coble_Lattice_Table.md"),
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectB", "Other_Paper.md"),
  "Standalone_Notes.md",
];

function workspaceSnapshots(): DocumentReferenceSnapshot[] {
  return WORKSPACE_FILES.map((relativePath) => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath);
    return extractReferences(documentPath, readFileSync(documentPath, "utf-8"));
  });
}

function resolutionFor(resolutions: Map<string, Resolution>, key: string): Resolution {
  const resolution = resolutions.get(key);
  assert.notStrictEqual(resolution, undefined, `the workspace must resolve the key ${key}`);
  return resolution as Resolution;
}

describe("resolveWorkspace()", function () {
  it("resolves every uniquely defined key to its single definition", function () {
    const resolutions = resolveWorkspace(workspaceSnapshots());

    const expected: Array<{ key: string; definedIn: string }> = [
      { key: "sec:moduli", definedIn: path.join("ProjectA", "Coble_Lattice_Table.md") },
      { key: "tbl:coble-lattices", definedIn: path.join("ProjectA", "Coble_Lattice_Table.md") },
      { key: "eq:intersection-form", definedIn: path.join("ProjectA", "Coble_Lattice_Table.md") },
      { key: "fig:root-diagram", definedIn: path.join("ProjectA", "Coble_Lattice_Table.md") },
      { key: "lst:sage-run", definedIn: path.join("ProjectA", "Coble_Lattice_Table.md") },
      { key: "lem:kodaira:embedding", definedIn: path.join("ProjectA", "Theorems.md") },
      { key: "prop:fibration-count", definedIn: path.join("ProjectA", "Theorems.md") },
      { key: "exr:compute-discriminant", definedIn: path.join("ProjectA", "Theorems.md") },
      { key: "def:lattice", definedIn: path.join("ProjectB", "Other_Paper.md") },
      { key: "rmk:standalone-note", definedIn: "Standalone_Notes.md" },
    ];

    for (const { key, definedIn } of expected) {
      const resolution = resolutionFor(resolutions, key);
      assert.strictEqual(resolution.status, "resolved", `${key} must resolve uniquely`);
      assert.ok(resolution.status === "resolved", key);
      assert.strictEqual(resolution.definition.key, key);
      assert.strictEqual(resolution.definition.documentPath, path.join(FIXTURE_ROOT, definedIn));
    }
  });

  it("reports missing for occurrences without any workspace definition", function () {
    const resolutions = resolveWorkspace(workspaceSnapshots());

    for (const key of ["fig:nonexistent-diagram", "lem:embedding"]) {
      const resolution = resolutionFor(resolutions, key);
      assert.strictEqual(
        resolution.status,
        "missing",
        `${key} has no definition anywhere in the workspace`,
      );
    }
  });

  it("retains every definition for a key duplicated across the workspace", function () {
    const resolutions = resolveWorkspace(workspaceSnapshots());
    const resolution = resolutionFor(resolutions, "thm:torelli");

    assert.strictEqual(
      resolution.status,
      "duplicate",
      "thm:torelli is defined twice and must never resolve silently",
    );
    assert.ok(resolution.status === "duplicate", "narrow for the definition list");
    assert.deepStrictEqual(
      resolution.definitions.map((definition) => definition.documentPath).sort(),
      [
        path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md"),
        path.join(FIXTURE_ROOT, "ProjectB", "Other_Paper.md"),
      ].sort(),
    );
    assert.deepStrictEqual(
      resolution.definitions.map((definition) => definition.key),
      ["thm:torelli", "thm:torelli"],
    );
  });
});
