/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotations panel animation performance and layout isolation spec
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real AnnotationsTab Vue component in Chromium
 *                  under offscreen Electron with 100 loaded annotation cards.
 *                  Proves that during toggle slide animations, the panel
 *                  content width is pinned to its target width and clipped by
 *                  the container rather than undergoing continuous reflows
 *                  across intermediate animation frames, and verifies
 *                  content-visibility isolation.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { runProbe } from "./visual/display-probe";

const execFileAsync = promisify(execFile);

interface StepLayoutReport {
  totalLayoutMs: number;
  stepTimes: number[];
  tabWidths: number[];
}

interface ToggleAnimationReport {
  targetState: "open" | "close";
  durationMs: number;
  frameCount: number;
  avgFrameMs: number;
  maxFrameMs: number;
  p95FrameMs: number;
  droppedFrames: number;
  severeDroppedFrames: number;
  frameTimesMs: number[];
}

interface AnimationProbeReport {
  unoptimized: {
    layout: StepLayoutReport;
    close: ToggleAnimationReport;
    open: ToggleAnimationReport;
  };
  optimized: {
    layout: StepLayoutReport;
    close: ToggleAnimationReport;
    open: ToggleAnimationReport;
  };
  hasContentVisibility: boolean;
  workspaceStateReads: number;
}

describe("Annotations panel animation performance and layout isolation", function () {
  let outputDirectory: string;
  let report: AnimationProbeReport;

  before(async function () {
    this.timeout(240000);
    outputDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-annotations-animation-"));
    const root = process.cwd();

    await execFileAsync(
      "node",
      [
        path.join(root, "test/visual-build.cjs"),
        path.join(root, "test/annotations-panel-animation-entry.ts"),
        "annotations-panel-animation-bundle.js",
        outputDirectory,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );

    const { stdout } = await runProbe(
      path.join(root, "test/annotations-panel-animation-probe.mjs"),
      [outputDirectory],
    );

    const jsonLine = stdout.trim().split("\n").at(-1);
    assert.ok(jsonLine !== undefined, "the animation probe must output a valid JSON report");
    report = JSON.parse(jsonLine as string) as AnimationProbeReport;
  });

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("proves unoptimized animation causes layout thrashing and tab width collapse across cards", function () {
    const { unoptimized, optimized } = report;
    // In unoptimized mode, the inner tab width is squeezed down from 320 to 20px
    assert.ok(
      unoptimized.layout.tabWidths.some((w) => w < 100),
      `unoptimized tab width must shrink with container: got ${JSON.stringify(unoptimized.layout.tabWidths)}`,
    );
    // Layout reflow time is significantly higher in unoptimized mode
    assert.ok(
      unoptimized.layout.totalLayoutMs > optimized.layout.totalLayoutMs,
      `unoptimized layout time (${unoptimized.layout.totalLayoutMs}ms) must exceed optimized layout time (${optimized.layout.totalLayoutMs}ms)`,
    );
  });

  it("proves optimized animation pins tab width at target size to eliminate card reflow", function () {
    const { optimized } = report;
    // Every sampled width during animation is pinned at 320px
    for (const w of optimized.layout.tabWidths) {
      assert.equal(w, 320, `optimized tab width must be held fixed at 320px: got ${w}`);
    }
  });

  it("completes open and close animation without severe dropped frames", function () {
    const { optimized } = report;
    assert.equal(
      optimized.close.severeDroppedFrames,
      0,
      `close animation must have 0 severe dropped frames: got ${optimized.close.severeDroppedFrames}`,
    );
    assert.equal(
      optimized.open.severeDroppedFrames,
      0,
      `open animation must have 0 severe dropped frames: got ${optimized.open.severeDroppedFrames}`,
    );
  });

  it("reads the workspace state one time for one list of paths (#126)", function () {
    assert.equal(
      report.workspaceStateReads,
      1,
      "a new array with the same paths starts no read of the workspace state",
    );
  });

  it("applies content-visibility: auto to workspace annotation rows", function () {
    assert.equal(
      report.hasContentVisibility,
      true,
      "annotation workspace rows must have content-visibility: auto",
    );
  });
});
