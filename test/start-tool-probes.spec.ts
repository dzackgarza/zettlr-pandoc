/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The tool probes of the start (issue #204)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The environment check of the start finds each external
 *                  tool that the app needs and reads the version of pandoc.
 *                  One probe of a tool answers each part of the check: a tool
 *                  starts one time. A probe has a time limit, so a tool that
 *                  does not answer stops the start with that cause; a tool
 *                  that is on the PATH but not executable is reported as
 *                  such, not as a tool that is not found.
 *
 *                  Each tool on the PATH of the check is a script that
 *                  records its start and runs the tool of the host.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import environmentCheck from "source/app/util/environment-check";
import { REQUIRED_COMMANDS } from "source/app/util/preflight";
import { appExitCodes, errorBoxes } from "./headless-electron-harness.cjs";

/** The PATH of the run, which holds the tools of the host. */
const HOST_PATH = (() => {
  const value = process.env.PATH;
  if (value === undefined) {
    throw new Error("The run has no PATH");
  }
  return value;
})();

/** The absolute path of a tool on the PATH of the host. */
function hostToolPath(tool: string): string {
  const found = spawnSync("which", [tool], { encoding: "utf8" });
  assert.strictEqual(found.status, 0, `${tool} is on the PATH of the test process`);
  return found.stdout.trim();
}

/** A tool that writes its name to `log` and runs the tool of the host. */
function recordingTool(tool: string, log: string): string {
  return [
    "#!/bin/bash",
    `echo ${JSON.stringify(tool)} >> ${JSON.stringify(log)}`,
    `export PATH=${JSON.stringify(HOST_PATH)}`,
    `exec ${JSON.stringify(hostToolPath(tool))} "$@"`,
    "",
  ].join("\n");
}

/** A tool that writes its name to `log` and then does not answer. */
function silentTool(tool: string, log: string): string {
  return [
    "#!/bin/bash",
    `echo ${JSON.stringify(tool)} >> ${JSON.stringify(log)}`,
    "exec /usr/bin/sleep 60",
    "",
  ].join("\n");
}

/** The names of the tools that started, one line for each start. */
function startedTools(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** Runs the environment check with `bin` as its PATH; null when it did not end in `limitMs`. */
async function checkWithPath(bin: string, limitMs: number): Promise<"ended" | null> {
  process.env.PATH = bin;
  try {
    return await Promise.race([
      environmentCheck().then(() => "ended" as const),
      sleep(limitMs).then(() => null),
    ]);
  } finally {
    process.env.PATH = HOST_PATH;
  }
}

describe("The tool probes of the start (issue #204)", function () {
  let root: string;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-start-probes-"));
  });

  beforeEach(function () {
    errorBoxes.length = 0;
    appExitCodes.length = 0;
  });

  after(async function () {
    await rm(root, { recursive: true, force: true });
  });

  it("start each tool one time", async function () {
    this.timeout(60_000);
    const bin = path.join(root, "all-tools");
    const log = path.join(root, "all-tools.log");
    await mkdir(bin);
    for (const { command } of REQUIRED_COMMANDS) {
      const tool = path.join(bin, command);
      await writeFile(tool, recordingTool(command, log));
      await chmod(tool, 0o755);
    }

    assert.equal(await checkWithPath(bin, 30_000), "ended", "the environment check ends");
    assert.deepEqual(errorBoxes, [], "the start finds each tool");
    assert.deepEqual(appExitCodes, [], "the start goes on");
    const starts = startedTools(log);
    assert.deepEqual(
      [...starts].sort(),
      REQUIRED_COMMANDS.map(({ command }) => command).sort(),
      `each tool starts one time; the starts were:\n${starts.join("\n")}`,
    );
  });

  it("stop with the cause of a tool that does not answer and of a tool that is not executable", async function () {
    this.timeout(90_000);
    const bin = path.join(root, "broken-tools");
    const log = path.join(root, "broken-tools.log");
    await mkdir(bin);
    for (const { command } of REQUIRED_COMMANDS) {
      const tool = path.join(bin, command);
      if (command === "biber") {
        await writeFile(tool, silentTool(command, log));
        await chmod(tool, 0o755);
      } else if (command === "latexmk") {
        await writeFile(tool, recordingTool(command, log));
        await chmod(tool, 0o644);
      } else {
        await writeFile(tool, recordingTool(command, log));
        await chmod(tool, 0o755);
      }
    }

    assert.equal(
      await checkWithPath(bin, 45_000),
      "ended",
      "the environment check ends although biber does not answer",
    );
    assert.deepEqual(appExitCodes, [1], "the start stops");
    assert.equal(errorBoxes.length, 1, "one error box gives the causes");
    const lines = errorBoxes[0].content.split("\n");
    const lineOf = (tool: string): string => {
      const line = lines.find((candidate) => candidate.includes(`• ${tool} `));
      assert.ok(line !== undefined, `the box names ${tool}:\n${errorBoxes[0].content}`);
      return line;
    };
    assert.match(lineOf("latexmk"), /not executable/, "latexmk is on the PATH and not executable");
    assert.doesNotMatch(lineOf("latexmk"), /not found/, "latexmk is not reported as absent");
    assert.match(lineOf("biber"), /did not answer/, "biber did not answer its probe");
    for (const { command } of REQUIRED_COMMANDS) {
      if (command === "biber" || command === "latexmk") continue;
      assert.ok(
        !lines.some((line) => line.includes(`• ${command} `)),
        `the box names no tool that answered (${command}):\n${errorBoxes[0].content}`,
      );
    }
  });
});
