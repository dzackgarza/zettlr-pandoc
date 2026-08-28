/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference diagnostics red proofs (issue #1 Phase 4)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the reference-lint contract by driving the linter
 *                  source directly against real headless EditorViews over
 *                  the fixture workspace: duplicate keys produce an error
 *                  listing ALL definition sites, missing references produce
 *                  warnings that never fabricate targets, class/prefix
 *                  mismatches produce an error naming BOTH conflicting
 *                  values plus a valid example, ids on proof divs produce an
 *                  info diagnostic, mixed bibliography/reference clusters
 *                  receive an advisory spanning the authored cluster, and no
 *                  diagnostic ever carries an auto-fix action.
 *
 * END HEADER
 */

import { forceParsing } from "@codemirror/language";
import { type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import { referenceLintSource } from "source/common/modules/markdown-editor/linters/reference-lint";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  type EditorWorkspaceReferences,
  workspaceReferencesField,
  workspaceReferencesUpdate,
} from "source/common/modules/markdown-editor/plugins/workspace-references-field";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { resolveWorkspace } from "source/common/pandoc-util/resolve-references";
import { type DocumentReferenceSnapshot } from "source/types/common/references";

function polyfillJsdomForCodeMirror(): void {
  const w = globalThis as any;
  if (typeof w.requestAnimationFrame !== "function") {
    w.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0);
    w.cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  if (typeof w.window === "object" && typeof w.window.requestAnimationFrame !== "function") {
    w.window.requestAnimationFrame = w.requestAnimationFrame;
    w.window.cancelAnimationFrame = w.cancelAnimationFrame;
  }
  if (typeof w.ResizeObserver !== "function") {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    if (typeof w.window === "object") {
      w.window.ResizeObserver = w.ResizeObserver;
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== "function") {
    w.Range.prototype.getClientRects = () => [];
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }
}

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const THEOREMS_PATH = path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md");
const COBLE_PATH = path.join(FIXTURE_ROOT, "ProjectA", "Coble_Lattice_Table.md");
const HALPHEN_PATH = path.join(FIXTURE_ROOT, "ProjectA", "Halphen_Surfaces.md");
const OTHER_PAPER_PATH = path.join(FIXTURE_ROOT, "ProjectB", "Other_Paper.md");

const WORKSPACE_FILES = [
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectA", "Coble_Lattice_Table.md"),
  path.join("ProjectA", "Halphen_Surfaces.md"),
  "Standalone_Notes.md",
  path.join("ProjectB", "Other_Paper.md"),
];

function workspaceSnapshots(): DocumentReferenceSnapshot[] {
  return WORKSPACE_FILES.map((relativePath) => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath);
    return extractReferences(documentPath, readFileSync(documentPath, "utf-8"));
  });
}

/** Every key actually defined somewhere in the given snapshots. */
function definedKeys(snapshots: DocumentReferenceSnapshot[]): Set<string> {
  return new Set(
    snapshots.flatMap((snapshot) => snapshot.definitions.map((definition) => definition.key)),
  );
}

describe("Reference diagnostics (issue #1 Phase 4)", function () {
  const views: EditorView[] = [];

  before(function () {
    polyfillJsdomForCodeMirror();
  });

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function createEditor(
    doc: string,
    snapshot: DocumentReferenceSnapshot,
    workspace: DocumentReferenceSnapshot[],
  ): EditorView {
    const payload: EditorWorkspaceReferences = {
      snapshot,
      workspaceOccurrences: workspace.flatMap((s) => s.occurrences),
      resolutions: resolveWorkspace(workspace),
    };
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdownParser(), configField, workspaceReferencesField],
    });
    const view = new EditorView({ state, parent: document.body });
    assert.ok(
      forceParsing(view, doc.length, 5000),
      "the syntax tree must be fully parsed before asserting",
    );
    view.dispatch({ effects: workspaceReferencesUpdate.of(payload) });
    views.push(view);
    return view;
  }

  function createFixtureEditor(documentPath: string): {
    view: EditorView;
    doc: string;
    workspace: DocumentReferenceSnapshot[];
  } {
    const doc = readFileSync(documentPath, "utf-8");
    const workspace = workspaceSnapshots();
    const snapshot = workspace.find((candidate) => candidate.documentPath === documentPath);
    assert.ok(snapshot !== undefined, `the fixture workspace must contain ${documentPath}`);
    return { view: createEditor(doc, snapshot, workspace), doc, workspace };
  }

  /** Every supported-family key token a diagnostic message mentions. */
  function familyKeyTokens(message: string): string[] {
    return (
      message.match(
        /\b(?:fig|tbl|eq|sec|lst|thm|lem|prop|cor|def|rmk|ex|conj|clm|obs|qst|prob|ass|warn|exr):[A-Za-z0-9:_-]+/g,
      ) ?? []
    );
  }

  function assertNoActions(diagnostics: Diagnostic[]): void {
    for (const diagnostic of diagnostics) {
      assert.ok(
        diagnostic.actions === undefined || diagnostic.actions.length === 0,
        `reference diagnostics never offer auto-fix actions: ${diagnostic.message}`,
      );
    }
  }

  it("reports a duplicate key as an error listing ALL definition sites", async function () {
    const { view, doc } = createFixtureEditor(THEOREMS_PATH);
    const diagnostics = await referenceLintSource(view);

    const idToken = "#thm:torelli";
    const from = doc.indexOf(idToken);
    assert.ok(from > 0, "the fixture must define thm:torelli");

    const duplicate = diagnostics.find(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.from === from,
    );
    assert.ok(
      duplicate !== undefined,
      "the duplicated definition must receive an error at its authored id range",
    );
    assert.strictEqual(duplicate.to, from + idToken.length);
    assert.ok(
      duplicate.message.includes(THEOREMS_PATH),
      "the error must name this definition site",
    );
    assert.ok(
      duplicate.message.includes(OTHER_PAPER_PATH),
      "the error must name every other definition site, never a silently selected subset",
    );

    // Unique definitions in the same document stay clean.
    for (const diagnostic of diagnostics) {
      assert.ok(
        !diagnostic.message.includes("lem:kodaira:embedding"),
        "uniquely defined keys must not be flagged",
      );
    }
    assertNoActions(diagnostics);
  });

  it("reports missing references as warnings at the authored occurrence without fabricating targets", async function () {
    const { view, doc, workspace } = createFixtureEditor(HALPHEN_PATH);
    const diagnostics = await referenceLintSource(view);

    const missingEmbedding = diagnostics.find((diagnostic) =>
      diagnostic.message.includes("lem:embedding"),
    );
    assert.ok(missingEmbedding !== undefined, "the undefined key lem:embedding must be reported");
    assert.strictEqual(missingEmbedding.severity, "warning");
    const embeddingFrom = doc.indexOf("@lem:embedding");
    assert.strictEqual(missingEmbedding.from, embeddingFrom);
    assert.strictEqual(missingEmbedding.to, embeddingFrom + "@lem:embedding".length);

    const missingFigure = diagnostics.find((diagnostic) =>
      diagnostic.message.includes("fig:nonexistent-diagram"),
    );
    assert.ok(
      missingFigure !== undefined,
      "the undefined key fig:nonexistent-diagram must be reported",
    );
    assert.strictEqual(missingFigure.severity, "warning");
    const figureFrom = doc.indexOf("@fig:nonexistent-diagram");
    assert.strictEqual(missingFigure.from, figureFrom);
    assert.strictEqual(missingFigure.to, figureFrom + "@fig:nonexistent-diagram".length);

    // Candidate suggestions are allowed but must be real workspace keys:
    // every family-prefixed key a missing-reference message mentions is
    // either the missing key itself or actually defined somewhere.
    const defined = definedKeys(workspace);
    for (const [diagnostic, missingKey] of [
      [missingEmbedding, "lem:embedding"],
      [missingFigure, "fig:nonexistent-diagram"],
    ] as Array<[Diagnostic, string]>) {
      for (const token of familyKeyTokens(diagnostic.message)) {
        assert.ok(
          token === missingKey || defined.has(token),
          `a missing-reference message may only name the missing key or real workspace keys, got: ${token}`,
        );
      }
    }

    // The resolved occurrences of this document stay clean.
    for (const key of ["tbl:coble-lattices", "eq:intersection-form", "sec:moduli"]) {
      const occurrenceFrom = doc.indexOf(`@${key}`);
      assert.ok(occurrenceFrom > 0, `the fixture must cite ${key}`);
      assert.ok(
        !diagnostics.some((diagnostic) => diagnostic.from === occurrenceFrom),
        `resolved key ${key} must not be flagged`,
      );
    }
    assertNoActions(diagnostics);
  });

  it("reports a class/prefix mismatch naming BOTH conflicting values and a valid example", async function () {
    const doc = "::: {.lemma #thm:foo}\nEvery bounded operator here is wrong.\n:::\n";
    const snapshot = extractReferences("crafted-mismatch.md", doc);
    const view = createEditor(doc, snapshot, [snapshot]);
    const diagnostics = await referenceLintSource(view);

    const idToken = "#thm:foo";
    const from = doc.indexOf(idToken);
    const mismatch = diagnostics.find((diagnostic) => diagnostic.from === from);
    assert.ok(
      mismatch !== undefined,
      "the conflicting definition must receive a diagnostic at its authored id range",
    );
    assert.strictEqual(mismatch.severity, "error");
    assert.strictEqual(mismatch.to, from + idToken.length);
    assert.ok(mismatch.message.includes("lemma"), "the error must name the authored div class");
    assert.ok(
      mismatch.message.includes("thm:foo"),
      "the error must name the authored conflicting id",
    );
    assert.ok(
      mismatch.message.includes("#lem:foo"),
      "the error must show a valid example per the THEOREM_DIV_PREFIXES mapping",
    );
    assertNoActions(diagnostics);
  });

  it("reports an id on a proof div as an info diagnostic: proofs are unreferenceable", async function () {
    const { view, doc } = createFixtureEditor(THEOREMS_PATH);
    const diagnostics = await referenceLintSource(view);

    const idToken = "#thm:should-not-index";
    const from = doc.indexOf(idToken);
    assert.ok(from > 0, "the fixture must carry an id on a proof div");

    const proof = diagnostics.find((diagnostic) => diagnostic.from === from);
    assert.ok(
      proof !== undefined,
      "the proof-div id must receive a diagnostic at its authored token",
    );
    assert.strictEqual(proof.severity, "info");
    assert.strictEqual(proof.to, from + idToken.length);
    assert.match(proof.message, /proof/i);
    assert.match(proof.message, /unreferenc/i);
    assertNoActions(diagnostics);
  });

  it("reports a mixed bibliography/reference cluster as an advisory spanning the authored cluster", async function () {
    const doc = "Combine [@thm:torelli; @Ols04, Lem. 7.1] for the argument.";
    const snapshot = extractReferences("crafted-mixed.md", doc);
    const workspace = workspaceSnapshots()
      .filter((candidate) => !candidate.documentPath.includes("ProjectB"))
      .concat([snapshot]);
    const view = createEditor(doc, snapshot, workspace);
    const diagnostics = await referenceLintSource(view);

    const clusterFrom = doc.indexOf("[");
    const clusterTo = doc.indexOf("]") + 1;
    const advisory = diagnostics.find(
      (diagnostic) => diagnostic.from === clusterFrom && diagnostic.to === clusterTo,
    );
    assert.ok(
      advisory !== undefined,
      "the mixed cluster must receive an advisory spanning the whole authored cluster",
    );
    assert.strictEqual(advisory.severity, "warning");
    assertNoActions(diagnostics);
  });

  it("reports nothing for a document whose definitions and occurrences all resolve cleanly", async function () {
    const { view } = createFixtureEditor(COBLE_PATH);
    const diagnostics = await referenceLintSource(view);

    assert.deepStrictEqual(
      diagnostics,
      [],
      "clean documents must produce zero reference diagnostics",
    );
  });
});
