/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The bound of TikZ compiles (issue #204)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The background lint and the live preview of the editor
 *                  compile TikZ figures in the main process. The lint
 *                  workers build the Flowmark context of several documents
 *                  at the same time; the editor renders a figure while they
 *                  run. These compiles share one bound: one TeX run at a
 *                  time, so no two runs write one cache file, and a figure
 *                  that two documents hold compiles one time. A preview goes
 *                  before the lint compiles that wait.
 *
 *                  A pdflatex on the PATH of the render records the start and
 *                  the end of each TeX run and runs the pdflatex of the host.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { renderTikz } from "@dzack/tikz-render/tikz-render";
import { buildFlowmarkLintContext } from "source/app/util/flowmark-lint-context";

const TIKZ_ASSET_DIR = path.join(__dirname, "../packages/tikz-render/test/fixtures/tikz-data");
const TIKZ_TEMPLATE = path.join(TIKZ_ASSET_DIR, "templates/standalone-tikz.tex");

/** The absolute path of a tool on the PATH of the test process. */
function hostToolPath(tool: string): string {
  const found = spawnSync("which", [tool], { encoding: "utf8" });
  assert.strictEqual(found.status, 0, `${tool} is on the PATH of the test process`);
  return found.stdout.trim();
}

/** A figure that no earlier run compiled; its TeX file names it by `name`. */
function figure(name: string): { name: string; source: string } {
  const mark = `figmark${name}${randomBytes(6).toString("hex")}`;
  return { name: mark, source: `\\begin{tikzcd}\n${mark} \\arrow[r] & B\n\\end{tikzcd}` };
}

/** A pdflatex that writes "start <figure>" and "end <figure>" to `log`. */
function recordingPdflatex(realPdflatex: string, log: string): string {
  return [
    "#!/bin/bash",
    `real=${JSON.stringify(realPdflatex)}`,
    'if [ "$1" = "--version" ]; then exec "$real" "$@"; fi',
    'tex="${!#}"',
    "mark=$(grep -o 'figmark[0-9a-z]*' \"$tex\" | head -n 1)",
    `echo "start $mark" >> ${JSON.stringify(log)}`,
    '"$real" "$@"',
    "code=$?",
    `echo "end $mark" >> ${JSON.stringify(log)}`,
    "exit $code",
    "",
  ].join("\n");
}

/** The lines of the TeX run log. */
function texRuns(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** The largest number of TeX runs that were active at one time. */
function mostAtOneTime(lines: readonly string[]): number {
  let active = 0;
  let most = 0;
  for (const line of lines) {
    active += line.startsWith("start ") ? 1 : -1;
    most = Math.max(most, active);
  }
  return most;
}

describe("TikZ compiles of the lint and the editor (issue #204)", function () {
  let root: string;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-tikz-bound-"));
  });

  after(async function () {
    await rm(root, { recursive: true, force: true });
  });

  it("run one TeX at a time, compile a shared figure one time, and give a preview the next run", async function () {
    this.timeout(180_000);
    const bin = path.join(root, "bin");
    const log = path.join(root, "tex-runs.log");
    await mkdir(bin);
    const wrapper = path.join(bin, "pdflatex");
    await writeFile(wrapper, recordingPdflatex(hostToolPath("pdflatex"), log));
    await chmod(wrapper, 0o755);

    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const tikzRenderConfig = {
      tikzAssetDir: TIKZ_ASSET_DIR,
      templatePath: TIKZ_TEMPLATE,
      cacheDir: path.join(root, "tikz-cache"),
      timeoutMs: 30_000,
      env,
    };
    const shared = figure("shared");
    const a1 = figure("aone");
    const a2 = figure("atwo");
    const b1 = figure("bone");
    const preview = figure("preview");
    const documentA = path.join(root, "a.md");
    const documentB = path.join(root, "b.md");
    const textA = `# A\n\n${shared.source}\n\n${a1.source}\n\n${a2.source}\n`;
    const textB = `# B\n\n${shared.source}\n\n${b1.source}\n`;
    await writeFile(documentA, textA);
    await writeFile(documentB, textB);
    const source = { homeDirectory: root, env, macroSources: [], tikzRenderConfig };

    // Two lint workers build the contexts of two documents at the same time.
    const lints = Promise.all([
      buildFlowmarkLintContext(textA, documentA, source),
      buildFlowmarkLintContext(textB, documentB, source),
    ]);
    while (texRuns(log).length === 0) {
      await sleep(10);
    }
    // The author opens a figure while the first lint compile runs.
    const previewResult = await renderTikz(
      { source: preview.source, kind: "raw", language: "tikzcd", docPath: documentA },
      tikzRenderConfig,
      "preview",
    );
    const contexts = await lints;

    const runs = texRuns(log);
    const report = runs.join("\n");
    assert.ok(
      previewResult.ok,
      `the preview renders: ${JSON.stringify(previewResult).slice(0, 400)}`,
    );
    for (const context of contexts) {
      assert.deepEqual(
        (context.compiler as { tikz: { diagnostics: unknown[] } }).tikz.diagnostics,
        [],
        "each linted figure compiles",
      );
    }
    assert.equal(mostAtOneTime(runs), 1, `one TeX run at a time:\n${report}`);
    assert.equal(
      runs.filter((line) => line === `start ${shared.name}`).length,
      1,
      `the figure of both documents compiles one time:\n${report}`,
    );
    assert.deepEqual(
      runs
        .filter((line) => line.startsWith("start "))
        .map((line) => line.slice("start ".length))
        .slice(0, 2),
      [shared.name, preview.name],
      `the preview has the run after the one that was active:\n${report}`,
    );
    assert.deepEqual(
      runs
        .filter((line) => line.startsWith("start "))
        .map((line) => line.slice("start ".length))
        .sort(),
      [shared.name, a1.name, a2.name, b1.name, preview.name].sort(),
      `each figure compiles:\n${report}`,
    );
  });
});
