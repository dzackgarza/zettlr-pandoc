/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unit-test temporary directory tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A spec makes its temporary directories below the
 *                  temporary directory of the system. A unit-test run leaves
 *                  none of them behind, whether or not the spec removed them.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const REPOSITORY = path.join(__dirname, "..");

describe("the temporary directories of a unit-test run", function () {
  it("are gone when the run ends, also the ones that a spec did not remove", async function () {
    const reportDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-temp-probe-report-"));
    const report = path.join(reportDirectory, "directory.txt");

    await promisify(execFile)(
      process.execPath,
      [
        "node_modules/mocha/bin/mocha.js",
        "--no-config",
        "--node-option",
        "import=tsx",
        "--require",
        "./test/setup.js",
        "--extension",
        "ts",
        "test/fixtures/temp-directory/probe.ts",
      ],
      { cwd: REPOSITORY, env: { ...process.env, ZETTLR_TEMP_PROBE_REPORT: report } },
    );

    const left = await readFile(report, "utf8");
    assert.ok(
      path.basename(left).startsWith("zettlr-temp-probe-"),
      `the probe reported "${left}", which is not a directory that it made`,
    );
    assert.equal(existsSync(left), false, `the run left ${left} behind`);
  });
});
