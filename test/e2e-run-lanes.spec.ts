/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        E2E lanes runner tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A spec file of an assembled-app run owns its loopback and
 *                  its processes. A first start of the app binds the default
 *                  Agent API port, so two such files in two lanes each bind
 *                  it. A file that leaves a process holds no lane, and the
 *                  process does not outlive the file, and a file does not
 *                  outlive its runner. A run can take one
 *                  shard of its files; the shards of a run hold each file
 *                  one time.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY = path.resolve(__dirname, "..");
const RUNNER = path.join(REPOSITORY, "e2e", "support", "run-lanes.ts");

// A spec file that binds the default Agent API port and holds it until each
// file of the run has an answer for its bind. The run directory is the
// meeting place: a file writes `<lane>.bound` or `<lane>.refused` there.
const PORT_SPEC_SOURCE = `
const assert = require("node:assert").strict;
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const directory = process.env.RUN_LANES_PROOF_DIRECTORY;
const answers = () => fs.readdirSync(directory).filter((name) => /\\.(bound|refused)$/.test(name));

it("binds 127.0.0.1:27412 while the file of another lane holds it", async function () {
  const server = net.createServer();
  const lane = process.env.E2E_LANE;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(27412, "127.0.0.1", resolve);
    });
  } catch (error) {
    fs.writeFileSync(path.join(directory, lane + ".refused"), "");
    throw error;
  }
  fs.writeFileSync(path.join(directory, lane + ".bound"), "");
  const deadline = Date.now() + 20000;
  while (answers().length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(answers().sort(), ["1.bound", "2.bound"]);
});
`;

// A process that accepts connections at the socket path of its last
// argument and ends after 40 s.
const LEFT_PROCESS_SOURCE = [
  'const net = require("node:net");',
  "const server = net.createServer();",
  'server.listen(process.argv.at(-1), () => console.log("listening"));',
  "setTimeout(() => process.exit(0), 40000);",
].join("\n");

// A spec file that starts that process in a process group of its own, as a
// spec starts the app, and does not stop it.
const LEFT_PROCESS_SPEC_SOURCE = `
const { spawn } = require("node:child_process");
const path = require("node:path");

it("starts a process and does not stop it", function (done) {
  const socketPath = path.join(process.env.RUN_LANES_PROOF_DIRECTORY, "left.sock");
  const left = spawn(process.execPath, ["-e", ${JSON.stringify(LEFT_PROCESS_SOURCE)}, socketPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  left.stdout.once("data", () => done());
});
`;

// A spec file whose test does not end and has no time limit of its own.
const ENDLESS_SPEC_SOURCE = `
it("does not end", function (done) {
  this.timeout(0);
  setInterval(() => {}, 1000);
});
`;

// A spec file whose test accepts connections at a socket of the run
// directory and does not end.
const ENDLESS_LISTENING_SPEC_SOURCE = `
const net = require("node:net");
const path = require("node:path");

it("accepts connections and does not end", function (done) {
  this.timeout(0);
  net.createServer().listen(path.join(process.env.RUN_LANES_PROOF_DIRECTORY, "file.sock"));
});
`;

// A spec file whose one test passes.
const PASSING_SPEC_SOURCE = `
it("passes", function () {});
`;

/** Answers whether a connection to the path is accepted, or the error code. */
async function connectOutcome(socketPath: string): Promise<string> {
  const client = connect(socketPath);
  const outcome = await new Promise<string>((resolve) => {
    client.once("connect", () => resolve("accepted"));
    client.once("error", (error: NodeJS.ErrnoException) => resolve(String(error.code)));
  });
  client.destroy();
  return outcome;
}

/** The arguments of each process that the user can read, by process id. */
async function processArguments(): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    // A process that ended after the listing has no arguments to read.
    const commandLine = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    found.set(Number(name), commandLine.split("\0"));
  }
  return found;
}

/** Waits until a connection to the path has the outcome, for at most the limit. */
async function untilConnectOutcome(
  socketPath: string,
  outcome: string,
  limitMs: number,
): Promise<string> {
  const deadline = Date.now() + limitMs;
  let last = await connectOutcome(socketPath);
  while (last !== outcome && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await connectOutcome(socketPath);
  }
  return last;
}

describe("E2E lanes runner", function () {
  this.timeout(90_000);
  let directory = "";

  beforeEach(async function () {
    directory = await mkdtemp(path.join(tmpdir(), "zettlr-run-lanes-"));
  });

  afterEach(async function () {
    // A process of a run that a test left names the run directory in its
    // arguments.
    for (const [pid, argv] of await processArguments()) {
      if (argv.some((argument) => argument.startsWith(directory))) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Runs the lanes runner on the files in the environment of an e2e run. A
   * file has `fileLimitSeconds`; the run itself has `timeoutMs`.
   */
  function runLanes(
    files: string[],
    fileLimitSeconds: number,
    timeoutMs: number,
    options: string[] = [],
  ): SpawnSyncReturns<string> {
    const runner = [process.execPath, "--import", "tsx", RUNNER];
    const limit = ["--file-limit-seconds", String(fileLimitSeconds)];
    return spawnSync("just", ["_e2e-run", ...runner, ...limit, ...options, ...files], {
      cwd: REPOSITORY,
      encoding: "utf8",
      env: { ...process.env, RUN_LANES_PROOF_DIRECTORY: directory },
      timeout: timeoutMs,
    });
  }

  it("gives each spec file a loopback of its own", async function () {
    const first = path.join(directory, "first-start-a.cjs");
    const second = path.join(directory, "first-start-b.cjs");
    await writeFile(first, PORT_SPEC_SOURCE, "utf8");
    await writeFile(second, PORT_SPEC_SOURCE, "utf8");

    const run = runLanes([first, second], 60, 60_000);

    assert.equal(
      run.status,
      0,
      `each of two files of one run binds 127.0.0.1:27412: ${run.stdout}${run.stderr}`,
    );
  });

  it("ends a file that left a process, and the process with it", async function () {
    const file = path.join(directory, "leaves-a-process.cjs");
    await writeFile(file, LEFT_PROCESS_SPEC_SOURCE, "utf8");

    const run = runLanes([file], 60, 20_000);

    assert.equal(
      run.status,
      0,
      `the run ends when the tests of the file ended (${String(run.error)}): ${run.stdout}${run.stderr}`,
    );
    assert.equal(
      await connectOutcome(path.join(directory, "left.sock")),
      "ECONNREFUSED",
      "the process that the file left does not run after the file",
    );
  });

  it("runs each file in one shard of the run", async function () {
    const names = ["a.cjs", "b.cjs", "c.cjs", "d.cjs", "e.cjs"];
    const files = names.map((name) => path.join(directory, name));
    for (const file of files) {
      await writeFile(file, PASSING_SPEC_SOURCE, "utf8");
    }
    // The order of the arguments is not the order of the shards.
    const given = [...files].reverse();

    const filesOfShard = (shard: string): string[] => {
      const run = runLanes(given, 60, 60_000, ["--shard", shard]);
      assert.equal(run.status, 0, `shard ${shard} passes: ${run.stdout}${run.stderr}`);
      return Array.from(run.stdout.matchAll(/^== (\S+) \(/gm), (match) =>
        path.basename(match[1]),
      ).sort();
    };

    assert.deepEqual(filesOfShard("1/2"), ["a.cjs", "c.cjs", "e.cjs"]);
    assert.deepEqual(filesOfShard("2/2"), ["b.cjs", "d.cjs"]);
  });

  it("refuses a shard that the run does not have", async function () {
    const file = path.join(directory, "a.cjs");
    await writeFile(file, PASSING_SPEC_SOURCE, "utf8");

    const run = runLanes([file], 60, 60_000, ["--shard", "3/2"]);

    assert.notEqual(run.status, 0, `the run fails: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /run-lanes: the shard 3\/2 is not one of 1\/2 to 2\/2/);
  });

  it("ends a file at its time limit and reports it as failed", async function () {
    const file = path.join(directory, "does-not-end.cjs");
    await writeFile(file, ENDLESS_SPEC_SOURCE, "utf8");

    const run = runLanes([file], 2, 30_000);

    assert.equal(
      run.status,
      1,
      `the run ends and fails when a file passed its limit (${String(run.error)}): ${run.stdout}${run.stderr}`,
    );
    assert.match(run.stdout, /does-not-end\.cjs \(no end in 2 s\)/);
  });

  it("ends the file of a runner that SIGKILL ended", async function () {
    const file = path.join(directory, "accepts-and-does-not-end.cjs");
    const socketPath = path.join(directory, "file.sock");
    await writeFile(file, ENDLESS_LISTENING_SPEC_SOURCE, "utf8");
    const runner = [process.execPath, "--import", "tsx", RUNNER, "--file-limit-seconds", "60"];
    spawn("just", ["_e2e-run", ...runner, file], {
      cwd: REPOSITORY,
      env: { ...process.env, RUN_LANES_PROOF_DIRECTORY: directory },
      stdio: "ignore",
    });
    assert.equal(
      await untilConnectOutcome(socketPath, "accepted", 30_000),
      "accepted",
      "the file of the run accepts connections",
    );
    const runners = [...(await processArguments())].filter(
      ([, argv]) => argv[0] === process.execPath && argv.includes(RUNNER) && argv.includes(file),
    );
    assert.equal(runners.length, 1, `one process is the runner of the file: ${String(runners)}`);

    process.kill(runners[0][0], "SIGKILL");

    assert.equal(
      await untilConnectOutcome(socketPath, "ECONNREFUSED", 10_000),
      "ECONNREFUSED",
      "the file does not run after its runner",
    );
  });
});
