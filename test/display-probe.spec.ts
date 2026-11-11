/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Display probe runner tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A probe that fails is the only evidence of a failure that
 *                  occurs once on a hosted runner. The error of the run
 *                  holds how the probe ended and all that it wrote.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProbe } from "./visual/display-probe";

// The error of a failed command can hold its command line. The probe writes
// its argument reversed, so the text that the assertions look for comes from
// the output of the probe alone.
const reversed = (text: string): string => [...text].reverse().join("");

const PROBE_SOURCE = [
  "const [mode, toStdout, toStderr] = process.argv.slice(-3);",
  'const reversed = (text) => [...text].reverse().join("");',
  "console.log(reversed(toStdout));",
  "console.error(reversed(toStderr));",
  'if (mode === "exit") process.exitCode = 73;',
  'if (mode === "kill") process.kill(process.pid, "SIGKILL");',
].join("\n");

describe("display probe runner", function () {
  let probe: string;
  let toStdout: string;
  let toStderr: string;

  before(async function () {
    const directory = await mkdtemp(path.join(tmpdir(), "zettlr-display-probe-"));
    probe = path.join(directory, "probe.mjs");
    await writeFile(probe, PROBE_SOURCE);
  });

  beforeEach(function () {
    toStdout = randomBytes(8).toString("hex");
    toStderr = randomBytes(8).toString("hex");
  });

  it("gives the output of a probe that succeeds", async function () {
    const { stdout, stderr } = await runProbe(probe, ["pass", toStdout, toStderr]);

    // The xvfb-run of some distributions joins the error output of the
    // command to its output.
    const output = stdout + stderr;
    assert.ok(output.includes(reversed(toStdout)), output);
    assert.ok(output.includes(reversed(toStderr)), output);
  });

  it("reports the exit code and the output of a probe that fails", async function () {
    await assert.rejects(runProbe(probe, ["exit", toStdout, toStderr]), (error: Error) => {
      assert.match(error.message, /\b73\b/);
      assert.ok(error.message.includes(reversed(toStdout)), error.message);
      assert.ok(error.message.includes(reversed(toStderr)), error.message);
      return true;
    });
  });

  it("reports the signal and the output of a probe that a signal ends", async function () {
    await assert.rejects(runProbe(probe, ["kill", toStdout, toStderr]), (error: Error) => {
      // The shell of xvfb-run gives 128 plus the signal number as its status.
      assert.match(error.message, /\b137\b/);
      assert.ok(error.message.includes(reversed(toStdout)), error.message);
      assert.ok(error.message.includes(reversed(toStderr)), error.message);
      return true;
    });
  });
});
