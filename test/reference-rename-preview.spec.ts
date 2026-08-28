/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Rename-preview dialog probe specs (issue #1, review A4 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real rename-preview dialog in Chromium
 *                  (webpack renderer bundle, xvfb Electron) over a rename
 *                  previewed with the production pipeline on the fixture
 *                  workspace. Locks the US-17/IS-12 preview contract:
 *                  before anything commits, the dialog lists every affected
 *                  document with its exact edit count and authored
 *                  snippets; Cancel commits nothing (no 'apply' intent);
 *                  Apply emits exactly one 'apply' intent for the host to
 *                  commit. While the dialog does not exist, the probe
 *                  reports that as structured data and every spec here
 *                  fails on assertions.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { execFile } from "child_process";
import { readFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface PreviewRow {
  documentPath: string | null;
  editCount: number | null;
  snippets: string[];
}

interface ProbeResult {
  componentAvailable: boolean;
  componentFailure: string | null;
  oldKey: string;
  newKey: string;
  expectedFiles: Array<{ documentPath: string; editCount: number; snippets: string[] }>;
  previewState: {
    oldKey: string | null;
    newKey: string | null;
    rows: PreviewRow[];
    applyPresent: boolean;
    cancelPresent: boolean;
  } | null;
  cancelScene: {
    cancelClicked: boolean;
    events: { applyCount: number; closeCount: number };
  } | null;
  applyScene: { applyClicked: boolean; events: { applyCount: number; closeCount: number } } | null;
  screenshots: string[];
}

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const AFFECTED_FILES = [
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectA", "Halphen_Surfaces.md"),
  path.join("ProjectB", "Other_Paper.md"),
  "Standalone_Notes.md",
];

describe("Rename preview dialog", function () {
  let outputDirectory: string;
  let result: ProbeResult;

  before(async function () {
    this.timeout(240000);
    outputDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-rename-preview-"));
    const root = process.cwd();
    await execFileAsync(
      "node",
      [path.join(root, "test/reference-rename-preview-build.cjs"), outputDirectory],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync(
      "xvfb-run",
      [
        "-a",
        path.join(root, "node_modules/.bin/electron"),
        "--ozone-platform=x11",
        "--disable-gpu",
        "--no-sandbox",
        path.join(root, "test/reference-rename-preview-probe.cjs"),
        outputDirectory,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const jsonLine = stdout.trim().split("\n").at(-1);
    assert.ok(
      jsonLine !== undefined,
      "the rename-preview probe must return its observed result object",
    );
    result = JSON.parse(jsonLine) as ProbeResult;
  });

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("mounts the RenameReferencePreviewDialog component from source/win-main", function () {
    assert.equal(
      result.componentFailure,
      null,
      `the rename-preview dialog must exist and mount: ${result.componentFailure ?? ""}`,
    );
    assert.equal(result.componentAvailable, true, "the dialog must report a successful mount");
  });

  it("presents the rename identity and the Apply/Cancel choice", function () {
    assert.ok(result.previewState !== null, "the mounted dialog must report its rendered state");
    assert.equal(result.previewState.oldKey, "thm:torelli");
    assert.equal(result.previewState.newKey, "thm:torelli-headline");
    assert.equal(result.previewState.applyPresent, true, "the dialog must offer Apply all");
    assert.equal(result.previewState.cancelPresent, true, "the dialog must offer Cancel");
  });

  it("lists the exact affected files and counts from the fixture", function () {
    // Independent oracle: the raw fixture sources. Each of the four
    // documents authors the old key exactly once (one definition or one
    // citing occurrence).
    const expected = AFFECTED_FILES.map((relative) => {
      const source = readFileSync(path.join(FIXTURE_ROOT, relative), "utf-8");
      const tokens =
        source.split("#thm:torelli").length - 1 + (source.split("@thm:torelli").length - 1);
      assert.ok(tokens > 0, `oracle precondition: ${relative} must author the key`);
      return { suffix: relative, editCount: tokens };
    });

    assert.ok(result.previewState !== null, "the mounted dialog must report its rendered state");
    const rows = result.previewState.rows;
    assert.equal(
      rows.length,
      expected.length,
      `the preview must list every affected document, got ${JSON.stringify(rows)}`,
    );
    for (const expectation of expected) {
      const row = rows.find(
        (candidate) =>
          candidate.documentPath !== null && candidate.documentPath.endsWith(expectation.suffix),
      );
      assert.ok(row !== undefined, `the preview must list ${expectation.suffix}`);
      assert.equal(
        row.editCount,
        expectation.editCount,
        `${expectation.suffix} must show its exact edit count`,
      );
      assert.equal(
        row.snippets.length,
        expectation.editCount,
        `${expectation.suffix} must show one snippet per affected range`,
      );
      for (const snippet of row.snippets) {
        assert.ok(
          snippet.includes("thm:torelli"),
          `every snippet must show the authored key in context, got ${JSON.stringify(snippet)}`,
        );
      }
    }
  });

  it("Cancel commits nothing: no apply intent is ever emitted", function () {
    assert.ok(result.cancelScene !== null, "the cancel scene must run");
    assert.equal(
      result.cancelScene.cancelClicked,
      true,
      "the probe must find and click [data-cancel]",
    );
    assert.deepEqual(
      result.cancelScene.events,
      { applyCount: 0, closeCount: 1 },
      "Cancel must emit exactly one close and NO apply — nothing may commit",
    );
  });

  it("Apply proceeds: exactly one apply intent for the host to commit", function () {
    assert.ok(result.applyScene !== null, "the apply scene must run");
    assert.equal(
      result.applyScene.applyClicked,
      true,
      "the probe must find and click [data-apply]",
    );
    assert.equal(
      result.applyScene.events.applyCount,
      1,
      "Apply must emit exactly one apply intent",
    );
  });
});
