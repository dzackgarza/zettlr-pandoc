/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The exit status of a Forge command whose subcommand a
 *                  signal ends (issue #71)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     `electron-forge package` starts its subcommand
 *                  `electron-forge-package.js` as a child process. When a
 *                  signal ends that child (earlyoom sends SIGTERM to the
 *                  webpack compile), the command must not answer success:
 *                  it exits with 128 + the number of the signal, the status
 *                  that a shell gives a program that a signal ended.
 *
 *                  The spec runs the real CLI of the repository, as the
 *                  `package` scripts do, and sends SIGTERM to the
 *                  subcommand as soon as it runs.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPOSITORY = path.join(__dirname, "..");
const FORGE = path.join(REPOSITORY, "node_modules", ".bin", "electron-forge");
const SUBCOMMAND = "electron-forge-package.js";
const POLL_MS = 50;

/** The pid of the subcommand that the Forge process started. */
async function subcommandPid(forge: ChildProcess, deadline: number): Promise<number> {
  if (forge.pid === undefined) {
    throw new Error("The Forge process did not start.");
  }
  while (Date.now() < deadline) {
    if (forge.exitCode !== null || forge.signalCode !== null) {
      throw new Error(
        `The Forge process ended (code ${forge.exitCode}, signal ${forge.signalCode}) before it started ${SUBCOMMAND}.`,
      );
    }
    // pgrep exits 1 when no process matches, 0 when one does.
    const search = spawnSync("pgrep", ["-P", String(forge.pid), "-f", SUBCOMMAND], {
      encoding: "utf8",
    });
    if (search.status === 0) {
      return Number.parseInt(search.stdout.trim(), 10);
    }
    if (search.status !== 1) {
      throw new Error(`pgrep failed (status ${search.status}): ${search.stderr}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`The Forge process did not start ${SUBCOMMAND} in time.`);
}

describe("A Forge command whose subcommand a signal ends", function () {
  it("exits with 128 + the number of the signal", async function () {
    const forge = spawn(FORGE, ["package", "--platform=linux", "--arch=x64"], {
      cwd: REPOSITORY,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        forge.on("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const child = await subcommandPid(forge, Date.now() + this.timeout() / 2);
    process.kill(child, "SIGTERM");
    assert.deepEqual(await exited, {
      code: 128 + constants.signals.SIGTERM,
      signal: null,
    });
  });
});
