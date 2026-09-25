/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Persistent editor tab lifecycle integration spec
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real EditorPane/MainEditor component tree in
 *                  Chromium and proves that revisiting an initialized tab
 *                  reuses its existing CodeMirror view rather than fetching
 *                  and rebuilding the document again.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface ProbeState {
  activePath: string | null;
  editorCount: number;
  activeEditorProbeId: string | null;
  activeScrollTop: number | null;
  fetchCounts: Record<string, number>;
}

interface ProbeReport {
  initial: ProbeState;
  restored: ProbeState;
}

describe("persistent editor tabs", function () {
  let outputDirectory: string;
  let report: ProbeReport;

  before(async function () {
    this.timeout(240000);
    outputDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-tab-persistence-"));
    const root = process.cwd();

    await execFileAsync(
      "node",
      [
        path.join(root, "test/visual-build.cjs"),
        path.join(root, "test/editor-tab-persistence-entry.ts"),
        "editor-tab-persistence-bundle.js",
        outputDirectory,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );

    await execFileAsync(
      "xvfb-run",
      ["-a", "node", path.join(root, "test/editor-tab-persistence-capture.mjs"), outputDirectory],
      { maxBuffer: 16 * 1024 * 1024 },
    );

    report = JSON.parse(await readFile(path.join(outputDirectory, "report.json"), "utf8")) as ProbeReport;
  });

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("reuses the same CodeMirror view when returning to an initialized tab", function () {
    assert.equal(report.initial.activeEditorProbeId, "alpha-editor");
    assert.equal(report.restored.activeEditorProbeId, "alpha-editor");
    assert.equal(report.initial.fetchCounts["/tmp/tab-persistence-a.md"], 1);
    assert.equal(report.restored.fetchCounts["/tmp/tab-persistence-a.md"], 1);
  });

  it("preserves the tab viewport while another tab is active", function () {
    assert.equal(report.initial.activeScrollTop, 600);
    assert.ok(
      report.restored.activeScrollTop !== null &&
        Math.abs(report.restored.activeScrollTop - 600) <= 2,
      `expected the retained viewport near 600px, got ${String(report.restored.activeScrollTop)}`,
    );
  });

  it("lazy-loads each visited tab once and keeps both initialized editors alive", function () {
    assert.equal(report.initial.editorCount, 1);
    assert.equal(report.restored.editorCount, 2);
    assert.equal(report.restored.fetchCounts["/tmp/tab-persistence-b.md"], 1);
  });
});
