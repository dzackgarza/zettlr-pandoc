/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The stop of a development server before a launch (#57)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     `just launch` runs `assert-dev-server-stopped.py --kill`
 *                  and then binds the port of the renderer server (3100).
 *                  The kill succeeds only when that port is free: a server
 *                  that the kill did not stop makes the launch die on
 *                  EADDRINUSE. Each case runs in a process and network
 *                  namespace of its own, so the script sees and stops only
 *                  the processes of the case, never a development app of the
 *                  author.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPOSITORY, "scripts", "assert-dev-server-stopped.py");

/**
 * Runs `setup` and then `--kill` in a new user, process and network
 * namespace, and answers the exit code of the script and whether the port
 * accepts connections after it.
 */
function killInNamespace(setup: string): { status: number | null; portOpen: string; log: string } {
  const run = spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "--mount-proc",
      "--net",
      "--",
      "bash",
      "-c",
      [
        "set -u",
        "ip link set lo up",
        setup,
        // Wait until the server of the case accepts connections.
        "for _ in $(seq 100); do (exec 3<>/dev/tcp/127.0.0.1/3100) 2>/dev/null && break; sleep 0.1; done",
        `python3 ${JSON.stringify(SCRIPT)} --kill`,
        'echo "status=$?"',
        '(exec 3<>/dev/tcp/127.0.0.1/3100) 2>/dev/null && echo "port=open" || echo "port=closed"',
      ].join("\n"),
    ],
    { cwd: REPOSITORY, encoding: "utf8", timeout: 60_000 },
  );
  const log = `${run.stdout}${run.stderr}`;
  const status = /status=(\d+)/.exec(run.stdout);
  const port = /port=(open|closed)/.exec(run.stdout);
  assert.ok(status !== null && port !== null, `the case ran to its end: ${log}`);
  return { status: Number(status[1]), portOpen: port[1], log };
}

describe("assert-dev-server-stopped.py --kill (#57)", function () {
  this.timeout(90_000);
  let scratch = "";

  before(async function () {
    scratch = await mkdtemp(path.join(tmpdir(), "zettlr-dev-server-kill-"));
    // A process that the script takes for `electron-forge start`: its
    // command names the entry point of Forge and it runs in the repository.
    await writeFile(
      path.join(scratch, "electron-forge-start.js"),
      [
        'const port = process.argv.at(-1) === "listen" ? 3100 : undefined;',
        'if (port !== undefined) require("node:net").createServer().listen(port, "127.0.0.1");',
        "setInterval(() => {}, 60_000);",
      ].join("\n"),
    );
  });

  after(async function () {
    await rm(scratch, { recursive: true, force: true });
  });

  it("stops a development server that holds the port, and succeeds", function () {
    const forge = path.join(scratch, "electron-forge-start.js");
    const { status, portOpen, log } = killInNamespace(`node ${JSON.stringify(forge)} listen &`);
    assert.equal(status, 0, log);
    assert.equal(portOpen, "closed", log);
  });

  it("fails when the port is still held after the kill", function () {
    const forge = path.join(scratch, "electron-forge-start.js");
    // The renderer port is held by a server that the script cannot name as
    // a development process (another working directory), beside a dev
    // process that it stops.
    const { status, portOpen, log } = killInNamespace(
      [
        `node ${JSON.stringify(forge)} &`,
        `(cd ${JSON.stringify(scratch)} && python3 -m http.server 3100 --bind 127.0.0.1 >/dev/null 2>&1 &)`,
      ].join("\n"),
    );
    assert.equal(portOpen, "open", log);
    assert.equal(status, 1, `the launch would bind a port that a server holds: ${log}`);
  });
});
