/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        runProcess and probeTool
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A run ends with no process of its group left when its time
 *                  limit passes; a run that waits for its group ends after
 *                  the last process that the program started; the cause of a
 *                  failed start tells an absent program, a program without
 *                  the execute bit and a missing working folder apart; a
 *                  probe that found its tool starts the tool one time.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeTool } from "../src/probe-tool";
import { runProcess } from "../src/run-process";

/**
 * Whether a process with this pid has not ended. A process in state Z has
 * ended; its entry stays until its parent collects it, and kill(2) still
 * finds it (https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).
 * `ps` exits 1 for a pid that has no entry.
 */
function running(pid: number): boolean {
  const listed = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  assert.ok(listed.status === 0 || listed.status === 1, `ps failed: ${listed.stderr}`);
  const state = listed.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

async function script(dir: string, name: string, body: string, mode: number): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return file;
}

describe("runProcess", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(path.join(tmpdir(), "external-process-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true });
  });

  it("stops each process of the group at the time limit", async function () {
    this.timeout(15_000);
    const pidFile = path.join(dir, "grandchild.pid");
    // The program starts a process that holds no output of the program, so
    // only a signal to the group reaches it.
    const program = await script(
      dir,
      "hang",
      `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 60`,
      0o755,
    );
    const started = Date.now();
    const outcome = await runProcess({
      command: program,
      args: [],
      env: process.env,
      timeLimitMs: 500,
      waitForGroup: false,
    });
    assert.equal(outcome.ended, "timeout");
    assert.ok(Date.now() - started < 5_000, "the run ends soon after its limit");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    // kill(2) returns when the signal is sent, before the process ends. A
    // process that got SIGKILL ends within a moment; one that got no signal
    // sleeps for a minute.
    const deadline = Date.now() + 1_000;
    while (running(grandchild) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(running(grandchild), false, "the process that the program started is stopped");
  });

  it("ends a run that waits for its group after the last process of the group", async function () {
    this.timeout(15_000);
    const marker = path.join(dir, "written");
    const program = await script(
      dir,
      "leave",
      `(sleep 1; echo done > ${marker}) </dev/null >/dev/null 2>&1 & exit 0`,
      0o755,
    );
    const outcome = await runProcess({
      command: program,
      args: [],
      env: process.env,
      timeLimitMs: 10_000,
      waitForGroup: true,
    });
    assert.deepEqual(outcome, { ended: "exit", code: 0, stdout: "", stderr: "" });
    assert.ok(existsSync(marker), "the process that the program left ran to its end first");
  });

  it("gives the text on standard input and the outputs of the program", async function () {
    const outcome = await runProcess({
      command: "sh",
      args: ["-c", "tr a-z A-Z; echo warn >&2; exit 3"],
      env: process.env,
      input: "pandoc\n",
      timeLimitMs: 10_000,
      waitForGroup: false,
    });
    assert.deepEqual(outcome, { ended: "exit", code: 3, stdout: "PANDOC\n", stderr: "warn\n" });
  });

  it("names a program that ends by a signal", async function () {
    const outcome = await runProcess({
      command: "sh",
      args: ["-c", "kill -TERM $$"],
      env: process.env,
      timeLimitMs: 10_000,
      waitForGroup: false,
    });
    assert.equal(outcome.ended, "signal");
    assert.equal(outcome.ended === "signal" && outcome.signal, "SIGTERM");
  });

  it("tells an absent program, a program without the execute bit and a missing folder apart", async function () {
    const run = async (command: string, cwd?: string) =>
      await runProcess({
        command,
        args: [],
        env: { PATH: dir },
        cwd,
        timeLimitMs: 10_000,
        waitForGroup: false,
      });

    await script(dir, "plain", "exit 0", 0o644);
    assert.deepEqual(await run("absent-tool"), { ended: "not-started", reason: "absent" });
    assert.deepEqual(await run("plain"), { ended: "not-started", reason: "not-executable" });
    const runnable = await script(dir, "runnable", "exit 0", 0o755);
    const missing = path.join(dir, "no-such-folder");
    const outcome = await run(runnable, missing);
    assert.equal(outcome.ended, "not-started");
    assert.equal(outcome.ended === "not-started" && outcome.reason, "no-working-directory");
  });
});

describe("probeTool", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(path.join(tmpdir(), "external-process-probe-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true });
  });

  it("starts a tool that answers one time for its PATH", async function () {
    const log = path.join(dir, "starts");
    await script(dir, "answers", `echo start >> ${log}; echo "answers 1.2.3"`, 0o755);
    const env = { PATH: dir };
    const [first, second] = await Promise.all([
      probeTool("answers", env),
      probeTool("answers", env),
    ]);
    const third = await probeTool("answers", env);
    for (const probe of [first, second, third]) {
      assert.deepEqual(probe, { status: "available", versionOutput: "answers 1.2.3\n" });
    }
    assert.equal(readFileSync(log, "utf8"), "start\n");
  });

  it("probes a tool that was not found again at the next request", async function () {
    const env = { PATH: dir };
    assert.deepEqual(await probeTool("installed-later", env), {
      status: "not-started",
      reason: "absent",
    });
    await script(dir, "installed-later", 'echo "installed-later 2"', 0o755);
    assert.deepEqual(await probeTool("installed-later", env), {
      status: "available",
      versionOutput: "installed-later 2\n",
    });
  });
});
