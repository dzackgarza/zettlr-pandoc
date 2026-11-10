/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark process runtime tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A Flowmark process starts processes of its own (Pandoc).
 *                  When the runtime stops a run, at the timeout or when the
 *                  app exits, no process of that run stays alive.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runFlowmarkProcess } from "source/app/util/flowmark-runtime";

// A parent that starts a long-running child apart from its own stdio, writes
// the process ids of both to the file named by its first argument, and then
// waits. It stands for `flowmark-lint` and the Pandoc process it starts.
const PARENT_WITH_CHILD = 'sleep 60 >/dev/null 2>&1 </dev/null & echo "$$ $!" > "$1"; wait';

async function processIds(pidFile: string): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await sleep(20);
  }
  const ids = (await readFile(pidFile, "utf8")).trim().split(" ").map(Number);
  assert.equal(ids.length, 2);
  return ids;
}

// The kernel keeps the entry of a process in /proc until its parent has
// collected it, so a stopped process can show for a moment.
async function survivors(ids: readonly number[]): Promise<number[]> {
  const deadline = Date.now() + 3_000;
  let alive = [...ids];
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(20);
    alive = alive.filter((id) => existsSync(`/proc/${String(id)}`));
  }
  return alive;
}

describe("Flowmark process runtime", function () {
  let scratch: string;
  let pidFile: string;

  beforeEach(async function () {
    scratch = await mkdtemp(path.join(tmpdir(), "zettlr-flowmark-runtime-"));
    pidFile = path.join(scratch, "pids");
  });

  afterEach(async function () {
    if (existsSync(pidFile)) {
      spawnSync("kill", ["-KILL", ...(await processIds(pidFile)).map(String)]);
    }
    await rm(scratch, { recursive: true, force: true });
  });

  it("a timed-out run leaves no process behind", async function () {
    const outcome = await runFlowmarkProcess({
      command: "sh",
      argv: ["-c", PARENT_WITH_CHILD, "sh", pidFile],
      timeoutMs: 500,
    });

    assert.deepEqual(
      { ok: outcome.ok, kind: outcome.ok ? undefined : outcome.kind },
      { ok: false, kind: "flowmark-timeout" },
    );
    assert.deepEqual(await survivors(await processIds(pidFile)), []);
  });

  it("the exit of the app leaves no process of a running run behind", async function () {
    // An app process that starts a run and exits while the run is active.
    const app = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        [
          'import { existsSync } from "node:fs";',
          `import { runFlowmarkProcess } from ${JSON.stringify(
            path.resolve("source/app/util/flowmark-runtime.ts"),
          )};`,
          "const [pidFile] = process.argv.slice(-1);",
          "void runFlowmarkProcess({",
          '  command: "sh",',
          `  argv: ["-c", ${JSON.stringify(PARENT_WITH_CHILD)}, "sh", pidFile],`,
          "  timeoutMs: 60_000,",
          "});",
          "const poll = setInterval(() => {",
          "  if (existsSync(pidFile)) {",
          "    clearInterval(poll);",
          "    process.exit(0);",
          "  }",
          "}, 20);",
        ].join("\n"),
        pidFile,
      ],
      { stdio: "inherit" },
    );
    const [exitCode] = await once(app, "exit");

    assert.equal(exitCode, 0);
    assert.deepEqual(await survivors(await processIds(pidFile)), []);
  });
});
