/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The error of a window whose log request fails
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A window sends each error to the log provider. When that
 *                  request fails (the channel has no handler, as before the
 *                  provider boots and after it shuts down), the error goes
 *                  to the console of the window, whose messages the main
 *                  process writes to the application log (`attachLogger`).
 *                  The window asks the log one time: the failure of the
 *                  request is not an error that it reports again. The scene
 *                  runs in the Electron of the app.
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

interface LogFailureProbeResult {
  logRequests: number;
  consoleErrors: string[];
}

describe("the error of a window whose log request fails", function () {
  let outputDirectory: string;
  let result: LogFailureProbeResult;

  before(async function () {
    this.timeout(240000);
    outputDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-renderer-log-failure-"));
    const root = process.cwd();
    await execFileAsync(
      "node",
      [
        path.join(root, "test/visual-build.cjs"),
        path.join(root, "test/renderer-log-failure-entry.ts"),
        "renderer-log-failure-bundle.js",
        outputDirectory,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const { stdout } = await runProbe(path.join(root, "test/renderer-log-failure-probe.mjs"), [
      outputDirectory,
    ]);
    const jsonLine = stdout.trim().split("\n").at(-1);
    assert.ok(jsonLine !== undefined, "the probe prints its result");
    result = JSON.parse(jsonLine) as LogFailureProbeResult;
  });

  after(async function () {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it("asks the log one time", function () {
    assert.equal(result.logRequests, 1);
  });

  it("writes the error, its details and the cause to the console of the window", function () {
    const reported = result.consoleErrors.filter((message) =>
      message.includes("Could not read the review of lattices.md"),
    );
    assert.equal(reported.length, 1, `console errors: ${JSON.stringify(result.consoleErrors)}`);
    assert.match(reported[0], /EACCES: permission denied/);
    assert.match(reported[0], /No handler registered for 'log-provider'/);
  });
});
