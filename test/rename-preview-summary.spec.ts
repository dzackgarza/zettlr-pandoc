/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Rename-preview summary specs (issue #1, review A4 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the pure per-file summary behind the rename preview
 *                  UI (US-17/IS-12: "Rename presents a complete preview"):
 *                  from a previewed WorkspaceReferenceEdit and the workspace
 *                  snapshots it was computed over, the summary names every
 *                  affected document with its exact edit count and the
 *                  authored context snippet of every affected range, in
 *                  document order. The independent oracle is a raw text
 *                  scan of the fixture sources for the authored old-key
 *                  tokens — never the summary's own inputs.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import {
  buildRenamePreviewSummary,
  previewReferenceRename,
} from "source/common/pandoc-util/compute-reference-edits";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import type { DocumentReferenceSnapshot } from "source/types/common/references";

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const WORKSPACE_FILES = [
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectA", "Halphen_Surfaces.md"),
  path.join("ProjectB", "Other_Paper.md"),
  "Standalone_Notes.md",
];

const OLD_KEY = "thm:torelli";
const NEW_KEY = "thm:torelli-headline";

function workspaceSnapshots(): DocumentReferenceSnapshot[] {
  return WORKSPACE_FILES.map((relative) => {
    const documentPath = path.join(FIXTURE_ROOT, relative);
    return extractReferences(documentPath, readFileSync(documentPath, "utf-8"));
  });
}

/** Independent oracle: authored old-key tokens per fixture document. */
function authoredTokenCount(relative: string): number {
  const source = readFileSync(path.join(FIXTURE_ROOT, relative), "utf-8");
  const definitionTokens = source.split(`#${OLD_KEY}`).length - 1;
  const occurrenceTokens = source.split(`@${OLD_KEY}`).length - 1;
  return definitionTokens + occurrenceTokens;
}

describe("Rename preview per-file summary (review A4)", function () {
  const snapshots = workspaceSnapshots();
  const preview = previewReferenceRename(snapshots, OLD_KEY, NEW_KEY);

  it("summarizes every affected document with its exact edit count", function () {
    assert.strictEqual(preview.status, "ok", "the fixture rename must preview cleanly");
    if (preview.status !== "ok") {
      return;
    }

    const summary = buildRenamePreviewSummary(preview.edit, snapshots, OLD_KEY);

    const expected = WORKSPACE_FILES.map((relative) => ({
      documentPath: path.join(FIXTURE_ROOT, relative),
      editCount: authoredTokenCount(relative),
    })).filter((entry) => entry.editCount > 0);
    assert.ok(
      expected.length >= 3,
      "the fixture must spread the key over several documents (oracle precondition)",
    );

    assert.deepStrictEqual(
      summary.map((file) => ({ documentPath: file.documentPath, editCount: file.editCount })),
      expected,
      "the summary must name every affected document with its authored token count, in document order",
    );
  });

  it("carries the authored context snippet of every affected range", function () {
    assert.strictEqual(preview.status, "ok");
    if (preview.status !== "ok") {
      return;
    }

    const summary = buildRenamePreviewSummary(preview.edit, snapshots, OLD_KEY);

    for (const file of summary) {
      assert.strictEqual(
        file.snippets.length,
        file.editCount,
        `${file.documentPath} must carry one snippet per affected range`,
      );
      for (const snippet of file.snippets) {
        assert.ok(
          snippet.includes(OLD_KEY),
          `every snippet must show the authored key in context, got ${JSON.stringify(snippet)}`,
        );
      }
    }

    // The citing documents show the authored cluster, not a bare key: the
    // Halphen cluster keeps its authored bracket syntax and companions.
    const halphen = summary.find((file) => file.documentPath.endsWith("Halphen_Surfaces.md"));
    assert.ok(halphen !== undefined, "Halphen_Surfaces.md cites the key and must be summarized");
    assert.ok(
      halphen.snippets.some((snippet) => snippet.includes("[@thm:torelli; @lem:embedding]")),
      `the authored citing cluster must appear as the snippet, got ${JSON.stringify(halphen.snippets)}`,
    );
  });
});
