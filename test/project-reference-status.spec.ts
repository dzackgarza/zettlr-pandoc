/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Project reference status red proofs (issue #1 Phase 7)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the pure Project-membership computation of
 *                  common/pandoc-util/project-reference-status.ts: the
 *                  per-definition status relative to the active document and
 *                  the visible Project roots, the completion-database
 *                  annotation, the fixed status -> insertion-affordance
 *                  decision table, the append-and-continue plans (including
 *                  the both-omitted source+target case), the pure
 *                  ProjectSettings application consumed by the existing
 *                  'update-project-properties' -> FSAL.updateProject()
 *                  surface, and the toast/status display wording.
 *
 *                  The workspace scene is the real reference-workspace
 *                  fixture (ProjectA, ProjectB, Standalone_Notes.md); the
 *                  fixture deliberately carries no .ztr-directory files, so
 *                  Project roots enter as explicit ProjectRootSpec values —
 *                  exactly the pure seam the provider uses.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import {
  annotateCompletionEntries,
  appendToastMessage,
  applyAppendPlan,
  completionAffordanceFor,
  computeAppendAndContinuePlan,
  computeProjectReferenceStatus,
  projectStatusDisplayName,
} from "source/common/pandoc-util/project-reference-status";
import type { ProjectSettings } from "source/types/common/fsal";
import type {
  AppendAndContinuePlan,
  ProjectRootSpec,
  ReferenceCompletionEntry,
} from "source/types/common/references";

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const PROJECT_A = path.join(FIXTURE_ROOT, "ProjectA");
const PROJECT_B = path.join(FIXTURE_ROOT, "ProjectB");

const THEOREMS = path.join(PROJECT_A, "Theorems.md");
const COBLE = path.join(PROJECT_A, "Coble_Lattice_Table.md");
const HALPHEN = path.join(PROJECT_A, "Halphen_Surfaces.md");
const OTHER_PAPER = path.join(PROJECT_B, "Other_Paper.md");
const STANDALONE = path.join(FIXTURE_ROOT, "Standalone_Notes.md");

/** ProjectA with every fixture file included, in ProjectSettings order. */
function projectARoot(files: string[]): ProjectRootSpec {
  return { rootPath: PROJECT_A, files };
}

const PROJECT_B_ROOT: ProjectRootSpec = { rootPath: PROJECT_B, files: ["Other_Paper.md"] };

/** Every definition of one fixture file as a raw completion entry. */
function entriesOf(documentPath: string): ReferenceCompletionEntry[] {
  const snapshot = extractReferences(documentPath, readFileSync(documentPath, "utf-8"));
  return snapshot.definitions.map((definition) => ({
    key: definition.key,
    family: definition.family,
    title: definition.title,
    documentPath: definition.documentPath,
  }));
}

describe("Project reference status computation (issue #1 Phase 7)", function () {
  describe("computeProjectReferenceStatus", function () {
    const bothRoots = [projectARoot(["Theorems.md", "Coble_Lattice_Table.md"]), PROJECT_B_ROOT];

    it("reports same-file for a definition in the active document, winning over membership", function () {
      // Theorems.md is listed in ProjectA's files, but the definition lives
      // in the active document itself: same-file always wins.
      assert.strictEqual(computeProjectReferenceStatus(THEOREMS, THEOREMS, bothRoots), "same-file");
    });

    it("reports in-active-project for a listed file of the active root", function () {
      assert.strictEqual(
        computeProjectReferenceStatus(COBLE, THEOREMS, bothRoots),
        "in-active-project",
      );
    });

    it("reports omitted-from-active-project for an in-root file missing from files", function () {
      // Halphen_Surfaces.md sits inside ProjectA but is not listed.
      assert.strictEqual(
        computeProjectReferenceStatus(HALPHEN, THEOREMS, bothRoots),
        "omitted-from-active-project",
      );
    });

    it("reports another-project for a definition under a different root", function () {
      assert.strictEqual(
        computeProjectReferenceStatus(OTHER_PAPER, THEOREMS, bothRoots),
        "another-project",
      );
    });

    it("reports standalone for a definition outside every root", function () {
      assert.strictEqual(
        computeProjectReferenceStatus(STANDALONE, THEOREMS, bothRoots),
        "standalone",
      );
    });

    it("classifies targets from a standalone active document", function () {
      // No root contains the active document: Project-rooted targets are
      // another-project, other standalone documents stay standalone, and the
      // active document itself is same-file.
      assert.strictEqual(
        computeProjectReferenceStatus(THEOREMS, STANDALONE, bothRoots),
        "another-project",
      );
      assert.strictEqual(
        computeProjectReferenceStatus(OTHER_PAPER, STANDALONE, bothRoots),
        "another-project",
      );
      assert.strictEqual(
        computeProjectReferenceStatus(
          path.join(FIXTURE_ROOT, "Other_Notes.md"),
          STANDALONE,
          bothRoots,
        ),
        "standalone",
      );
      assert.strictEqual(
        computeProjectReferenceStatus(STANDALONE, STANDALONE, bothRoots),
        "same-file",
      );
    });

    it("activates the containing root even when the active document is itself omitted", function () {
      // Halphen_Surfaces.md is inside ProjectA but not listed; ProjectA is
      // still the ACTIVE Project for it, so listed siblings are
      // in-active-project and unlisted siblings are omitted.
      const roots = [projectARoot(["Theorems.md"]), PROJECT_B_ROOT];
      assert.strictEqual(
        computeProjectReferenceStatus(THEOREMS, HALPHEN, roots),
        "in-active-project",
      );
      assert.strictEqual(
        computeProjectReferenceStatus(COBLE, HALPHEN, roots),
        "omitted-from-active-project",
      );
      assert.strictEqual(
        computeProjectReferenceStatus(OTHER_PAPER, HALPHEN, roots),
        "another-project",
      );
    });

    it("uses path-segment-safe root containment", function () {
      // A sibling directory whose name merely extends the root's name is NOT
      // inside the root: ProjectA must not claim ProjectAB.
      const lookalike = path.join(FIXTURE_ROOT, "ProjectAB", "Notes.md");
      assert.strictEqual(
        computeProjectReferenceStatus(lookalike, THEOREMS, bothRoots),
        "standalone",
      );
      assert.strictEqual(
        computeProjectReferenceStatus(THEOREMS, lookalike, bothRoots),
        "another-project",
      );
    });
  });

  describe("annotateCompletionEntries", function () {
    it("computes the status of every real fixture definition (included active document)", function () {
      // Active: Theorems.md (listed). ProjectA lists Theorems + Coble only.
      const roots = [projectARoot(["Theorems.md", "Coble_Lattice_Table.md"]), PROJECT_B_ROOT];
      const raw = [THEOREMS, COBLE, HALPHEN, STANDALONE, OTHER_PAPER].flatMap(entriesOf);
      assert.ok(
        raw.length >= 10,
        "the fixture workspace must provide a representative definition set",
      );

      const expectedByPath: Record<string, string> = {
        [THEOREMS]: "same-file",
        [COBLE]: "in-active-project",
        [HALPHEN]: "omitted-from-active-project",
        [STANDALONE]: "standalone",
        [OTHER_PAPER]: "another-project",
      };

      const annotated = annotateCompletionEntries(raw, THEOREMS, roots);
      assert.deepStrictEqual(
        annotated.map((entry) => [entry.key, entry.projectStatus]),
        raw.map((entry) => [entry.key, expectedByPath[entry.documentPath]]),
      );

      // The input entries are data, not a scratchpad: no mutation.
      assert.ok(raw.every((entry) => entry.projectStatus === undefined));
    });

    it("attaches the append plan exactly on omitted entries (omitted active document)", function () {
      // Active: Halphen_Surfaces.md, itself omitted; only Theorems.md is
      // listed. Coble entries are omitted AND appendable: the plan appends
      // the omitted SOURCE first, then the target.
      const roots = [projectARoot(["Theorems.md"]), PROJECT_B_ROOT];
      const raw = [THEOREMS, COBLE, STANDALONE, OTHER_PAPER].flatMap(entriesOf);

      const annotated = annotateCompletionEntries(raw, HALPHEN, roots);
      const expectedPlan: AppendAndContinuePlan = {
        rootPath: PROJECT_A,
        appendFiles: ["Halphen_Surfaces.md", "Coble_Lattice_Table.md"],
      };

      assert.deepStrictEqual(
        annotated.map((entry) => [entry.key, entry.projectStatus, entry.appendPlan]),
        raw.map((entry) => [
          entry.key,
          entry.documentPath === COBLE
            ? "omitted-from-active-project"
            : entry.documentPath === THEOREMS
              ? "in-active-project"
              : entry.documentPath === OTHER_PAPER
                ? "another-project"
                : "standalone",
          entry.documentPath === COBLE ? expectedPlan : undefined,
        ]),
      );
    });
  });

  describe("computeAppendAndContinuePlan", function () {
    const roots = [projectARoot(["Theorems.md"]), PROJECT_B_ROOT];

    it("plans a single append for an omitted target from an included source", function () {
      const plan = computeAppendAndContinuePlan(COBLE, THEOREMS, roots);
      assert.deepStrictEqual(plan, {
        rootPath: PROJECT_A,
        appendFiles: ["Coble_Lattice_Table.md"],
      });
    });

    it("plans both files, source first, when the source is also omitted", function () {
      const plan = computeAppendAndContinuePlan(COBLE, HALPHEN, roots);
      assert.deepStrictEqual(plan, {
        rootPath: PROJECT_A,
        appendFiles: ["Halphen_Surfaces.md", "Coble_Lattice_Table.md"],
      });
    });

    it("uses Unix-separator project-relative paths for nested targets", function () {
      const nested = path.join(PROJECT_A, "sections", "Extra.md");
      const plan = computeAppendAndContinuePlan(nested, THEOREMS, roots);
      assert.deepStrictEqual(plan, {
        rootPath: PROJECT_A,
        appendFiles: ["sections/Extra.md"],
      });
    });

    it("returns null for every non-appendable configuration", function () {
      // Included target: nothing to append.
      assert.strictEqual(computeAppendAndContinuePlan(THEOREMS, HALPHEN, roots), null);
      // Target in another Project root: insertion is disabled, never appended.
      assert.strictEqual(computeAppendAndContinuePlan(OTHER_PAPER, THEOREMS, roots), null);
      // Standalone target: not in the root, cannot be appended.
      assert.strictEqual(computeAppendAndContinuePlan(STANDALONE, THEOREMS, roots), null);
      // Standalone ACTIVE document: no active Project to amend.
      assert.strictEqual(computeAppendAndContinuePlan(COBLE, STANDALONE, roots), null);
    });
  });

  describe("applyAppendPlan", function () {
    it("appends the planned files to a scratch ProjectSettings without touching anything else", function () {
      const settings: ProjectSettings = {
        title: "Coble Lattice Notes",
        profiles: ["PDF Document.yaml"],
        files: ["Theorems.md"],
        cslStyle: "",
        templates: { tex: "lattice-notes.latex", html: "" },
      };
      const plan: AppendAndContinuePlan = {
        rootPath: PROJECT_A,
        appendFiles: ["Halphen_Surfaces.md", "Coble_Lattice_Table.md"],
      };

      const updated = applyAppendPlan(settings, plan);

      // The returned value is exactly the `properties` payload the existing
      // 'update-project-properties' command passes to FSAL.updateProject():
      // ordered files with the plan appended at the end, everything else
      // preserved.
      assert.deepStrictEqual(updated, {
        title: "Coble Lattice Notes",
        profiles: ["PDF Document.yaml"],
        files: ["Theorems.md", "Halphen_Surfaces.md", "Coble_Lattice_Table.md"],
        cslStyle: "",
        templates: { tex: "lattice-notes.latex", html: "" },
      });

      // The input settings object is never mutated.
      assert.deepStrictEqual(settings.files, ["Theorems.md"]);
    });
  });

  describe("appendToastMessage", function () {
    it("names both appended files in one toast for a source+target plan", function () {
      const message = appendToastMessage({
        rootPath: PROJECT_A,
        appendFiles: ["Halphen_Surfaces.md", "Coble_Lattice_Table.md"],
      });
      assert.ok(
        message.includes("Halphen_Surfaces.md"),
        `the toast must name the appended source: ${JSON.stringify(message)}`,
      );
      assert.ok(
        message.includes("Coble_Lattice_Table.md"),
        `the toast must name the appended target: ${JSON.stringify(message)}`,
      );
    });

    it("names the single appended file for a target-only plan", function () {
      const message = appendToastMessage({
        rootPath: PROJECT_A,
        appendFiles: ["Coble_Lattice_Table.md"],
      });
      assert.ok(
        message.includes("Coble_Lattice_Table.md"),
        `the toast must name the appended file: ${JSON.stringify(message)}`,
      );
    });
  });

  describe("completionAffordanceFor", function () {
    const plan: AppendAndContinuePlan = {
      rootPath: PROJECT_A,
      appendFiles: ["Coble_Lattice_Table.md"],
    };

    it("inserts plainly for undefined, same-file, and in-active-project statuses", function () {
      assert.deepStrictEqual(completionAffordanceFor(undefined), { kind: "insert" });
      assert.deepStrictEqual(completionAffordanceFor("same-file"), { kind: "insert" });
      assert.deepStrictEqual(completionAffordanceFor("in-active-project"), { kind: "insert" });
    });

    it("disables insertion for another-project entries", function () {
      assert.deepStrictEqual(completionAffordanceFor("another-project"), {
        kind: "disabled-another-project",
      });
    });

    it("carries the append action for omitted entries with a plan", function () {
      assert.deepStrictEqual(completionAffordanceFor("omitted-from-active-project", plan), {
        kind: "insert-with-append",
        plan,
      });
    });

    it("inserts plainly for omitted entries carrying no mechanical append plan", function () {
      assert.deepStrictEqual(completionAffordanceFor("omitted-from-active-project"), {
        kind: "insert",
      });
    });

    it("warns about the export unit for standalone entries", function () {
      assert.deepStrictEqual(completionAffordanceFor("standalone"), {
        kind: "insert-with-export-warning",
      });
    });
  });

  describe("projectStatusDisplayName", function () {
    it("renders the exact user-facing status wording", function () {
      assert.strictEqual(projectStatusDisplayName("same-file"), "This file");
      assert.strictEqual(projectStatusDisplayName("in-active-project"), "In active Project");
      assert.strictEqual(
        projectStatusDisplayName("omitted-from-active-project"),
        "Omitted from active Project",
      );
      assert.strictEqual(projectStatusDisplayName("another-project"), "Another Project");
      assert.strictEqual(projectStatusDisplayName("standalone"), "Standalone document");
    });
  });
});
