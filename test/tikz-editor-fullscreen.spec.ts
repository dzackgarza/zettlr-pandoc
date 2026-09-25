import { strict as assert } from "assert";
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

describe("embedded TikZ editor fullscreen exit", function () {
  let outputDirectory: string;
  let report: { buttonExit: boolean; escapeExit: boolean };

  before(async function () {
    this.timeout(240000);
    outputDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-tikz-editor-fullscreen-"));
    const root = process.cwd();
    await execFileAsync(
      "node",
      [
        path.join(root, "test/visual-build.cjs"),
        path.join(root, "test/tikz-editor-fullscreen-entry.ts"),
        "tikz-editor-fullscreen-bundle.js",
        outputDirectory,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync(
      "xvfb-run",
      ["-a", "node", path.join(root, "test/tikz-editor-fullscreen-capture.mjs"), outputDirectory],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    report = JSON.parse(stdout) as { buttonExit: boolean; escapeExit: boolean };
  });

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("exits fullscreen from the embedded control and Escape inside the iframe", function () {
    assert.deepEqual(report, { buttonExit: true, escapeExit: true });
  });
});
