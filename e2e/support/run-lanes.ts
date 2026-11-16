/**
 * Runs assembled-app spec files in lanes (#70).
 *
 * Each spec file starts the app, and a run of the files one after the other
 * takes the sum of their times. The runner runs `LANES` files at the same
 * time. A lane owns one virtual X display (Xvfb), and a spec file of the lane
 * runs on that display alone: a native message box, a key that `xdotool`
 * presses and the focus of a window are not shared with the spec of another
 * lane. Each file runs in a Mocha process of its own, in namespaces of its
 * own (`FILE_NAMESPACES`): a loopback, so each file binds the port that
 * another file binds (a first start of the app binds the default Agent API
 * port), and a process tree, so no process of a file runs after the file.
 * Mocha ends when the tests and the hooks of the file ended (`--exit`), so a
 * handle or a process that a file left holds no lane. A file has a time
 * limit (`--file-limit-seconds`): at the limit the runner ends the file with
 * each of its processes and reports it as failed. The process gets the number
 * of its lane
 * in `E2E_LANE`; a start that compiles the app takes its Forge ports from it
 * (`forgePortsOfLane`, `electron-app.ts`). Each file gets the source
 * fingerprint of the start of the run in `E2E_SOURCE_FINGERPRINT`.
 *
 * The output of a file is printed whole when the file ends, with the time of
 * the file. After the last file the runner prints each file by time, the
 * slowest first, with its result, and the wall time of the run. The runner
 * exits 1 when a file failed.
 *
 * A run can take one shard of its files (`--shard <index>/<count>`, the
 * form of the `--shard` option of Jest and of Playwright), so that the
 * machines of a hosted run each take a part. The runner sorts the files and
 * deals them to the shards in turn: each file is in one shard, and the
 * shards differ by one file at most.
 *
 * Usage: node --import tsx e2e/support/run-lanes.ts
 *          --file-limit-seconds <seconds> [--shard <index>/<count>]
 *          <spec file>...
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { userInfo } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";

/**
 * Three apps at a time: the hosted runner has 4 processors and 16 GB, and
 * each lane holds one app and its Mocha process. On the workstation the run
 * shares 15 GB with the desktop of the author.
 */
const LANES = 3;

/** A test or a hook has 90 s (AGENTS.md §13). */
/**
 * The arguments of mocha for one spec file. `--forbid-only` fails a file
 * with an exclusive test (`.only`), which would pass with the other tests
 * of the file not run; `--forbid-pending` fails a file with a test that is
 * skipped or has no body; `--fail-zero` fails a file without a test, and a
 * file name that names no file. `--file` loads the hooks of each file: the
 * screenshots of a failed test and the renderer gate (`root-hooks.ts`).
 */
const MOCHA_ARGS = [
  "--no-config",
  "--node-option",
  "import=tsx",
  "--timeout",
  "90000",
  "--exit",
  "--forbid-only",
  "--forbid-pending",
  "--fail-zero",
  "--file",
  "e2e/support/root-hooks.ts",
];

/**
 * The namespaces of one spec file (unshare(1)), inside those of the run
 * (`_e2e-run` of the justfile). The network namespace has `lo` and no other
 * interface. The process namespace ends with its first process: the kernel
 * then ends each process that is left in it (pid_namespaces(7)).
 */
const FILE_NAMESPACES = [
  "--user",
  "--map-root-user",
  "--net",
  "--pid",
  "--fork",
  "--kill-child",
  "--mount-proc",
];

/**
 * The first process of the namespaces of a file: a shell that turns the
 * loopback on, runs the command of its arguments as the user of the run, and
 * exits with the status of the command. The shell stays the first process
 * (the `exit` after the command): it takes each process that lost its parent,
 * and the command has the signal rules of an ordinary process.
 */
const FILE_INIT = [
  "ip link set lo up",
  '&& unshare --map-user="$0" --map-group="$1" -- "${@:2}"',
  "; exit $?",
].join(" ");

/**
 * The start of a child that ends with the runner: the kernel sends the child
 * SIGKILL when the runner ends, also when a signal that the runner cannot
 * handle ended it (setpriv(1), `PR_SET_PDEATHSIG` of prctl(2)). The time
 * limit of a file is a timer of the runner, so a file without this would
 * have no limit after its runner.
 */
const ENDS_WITH_RUNNER = ["--pdeathsig", "KILL"];

interface FileResult {
  file: string;
  lane: number;
  seconds: number;
  /** The exit code of Mocha (the count of failed tests), or the signal that ended it. */
  outcome: string;
  failed: boolean;
}

/**
 * The line that a server writes to its descriptor 3 when it accepts
 * connections. A server that ends before the line rejects with its error
 * output.
 */
async function readyLine(server: ChildProcess, name: string): Promise<string> {
  let errors = "";
  server.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const lines = server.stdio[3] as Readable;
  let written = "";
  return await new Promise<string>((resolve, reject) => {
    lines.on("data", (chunk: Buffer) => {
      written += chunk.toString();
      if (written.includes("\n")) {
        resolve(written.trim());
      }
    });
    server.once("error", reject);
    server.once("exit", (code, signal) => {
      const ended = signal === null ? `exit ${code}` : signal;
      reject(new Error(`${name} ended before it accepted connections (${ended}): ${errors}`));
    });
  });
}

/** Ends a server of the run and waits for its end. */
async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
}

interface Display {
  name: string;
  server: ChildProcess;
}

/**
 * Starts an Xvfb server on a free display. `-displayfd` makes the server
 * choose the number and write it to the descriptor when it accepts
 * connections (Xserver(1)).
 */
async function startDisplay(): Promise<Display> {
  const server = spawn(
    "setpriv",
    [
      ...ENDS_WITH_RUNNER,
      "Xvfb",
      "-displayfd",
      "3",
      "-screen",
      "0",
      "1920x1080x24",
      "-nolisten",
      "tcp",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  return { name: `:${await readyLine(server, "Xvfb")}`, server };
}

interface SessionBus {
  address: string;
  server: ChildProcess;
}

/**
 * Starts the session bus of the run: a bus without services
 * (`scripts/e2e-session-bus.conf`), so a desktop notification of an app of
 * the run does not reach the desktop of the author. `--print-address` makes
 * the daemon write its address to the descriptor when it accepts
 * connections (dbus-daemon(1)).
 *
 * The daemon is a child of the runner, as the Xvfb server of a lane is.
 * dbus-run-session(1) cannot hold the run: it gives no signal to the
 * program that it started, and its daemon does not end with it.
 */
async function startSessionBus(): Promise<SessionBus> {
  const server = spawn(
    "setpriv",
    [
      ...ENDS_WITH_RUNNER,
      "dbus-daemon",
      `--config-file=${path.join(process.cwd(), "scripts", "e2e-session-bus.conf")}`,
      "--nofork",
      "--print-address=3",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  return { address: await readyLine(server, "dbus-daemon"), server };
}

const running = new Set<ChildProcess>();

/**
 * The source fingerprint at the start of the run. Each file compares the
 * stamp of the package with it (`currentPackagedDirectory`,
 * `electron-app.ts`), so a commit during the run stops no later file.
 */
const sourceFingerprint = execFileSync(
  path.join(process.cwd(), "scripts", "desktop", "zettlr-pandoc-source-fingerprint"),
  [process.cwd()],
  { encoding: "utf8" },
).trim();

async function runFile(
  file: string,
  lane: number,
  display: Display,
  bus: SessionBus,
  fileLimitSeconds: number,
): Promise<FileResult> {
  const mocha = path.join(process.cwd(), "node_modules", ".bin", "mocha");
  const startedAt = Date.now();
  const { uid, gid } = userInfo();
  const init = ["bash", "-c", FILE_INIT, String(uid), String(gid)];
  const unshare = ["unshare", ...FILE_NAMESPACES, "--", ...init, mocha, ...MOCHA_ARGS, file];
  const child = spawn("setpriv", [...ENDS_WITH_RUNNER, ...unshare], {
    env: {
      ...process.env,
      DISPLAY: display.name,
      DBUS_SESSION_BUS_ADDRESS: bus.address,
      E2E_LANE: String(lane),
      E2E_SOURCE_FINGERPRINT: sourceFingerprint,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  let passedLimit = false;
  const limit = setTimeout(() => {
    passedLimit = true;
    child.kill("SIGKILL");
  }, fileLimitSeconds * 1000);
  const output: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  clearTimeout(limit);
  running.delete(child);
  const seconds = (Date.now() - startedAt) / 1000;
  const ended = signal === null ? `exit ${code}` : signal;
  const outcome = passedLimit ? `no end in ${fileLimitSeconds} s` : ended;
  process.stdout.write(
    `\n== ${file} (lane ${lane}, ${seconds.toFixed(1)} s, ${outcome})\n${Buffer.concat(output).toString()}`,
  );
  return { file, lane, seconds, outcome, failed: code !== 0 };
}

async function runLane(
  lane: number,
  results: FileResult[],
  bus: SessionBus,
  fileLimitSeconds: number,
): Promise<void> {
  const display = await startDisplay();
  try {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      results.push(await runFile(file, lane, display, bus, fileLimitSeconds));
    }
  } finally {
    await stopServer(display.server);
  }
}

function printTable(results: FileResult[], wallSeconds: number): void {
  const rows = [...results].sort((a, b) => b.seconds - a.seconds);
  const width = Math.max(4, ...rows.map((row) => row.file.length));
  console.log(`\n  ${"File".padEnd(width)}  Seconds  Result`);
  for (const row of rows) {
    console.log(
      `  ${row.file.padEnd(width)}  ${row.seconds.toFixed(1).padStart(7)}  ${row.outcome}`,
    );
  }
  const failed = rows.filter((row) => row.failed);
  console.log(
    `\n  ${rows.length} files in ${LANES} lanes, ${wallSeconds.toFixed(1)} s; ${failed.length} failed`,
  );
  for (const row of failed) {
    console.log(`  failed: ${row.file} (${row.outcome})`);
  }
}

/**
 * The files of one shard of a run: the sorted files, dealt to the shards
 * in turn.
 */
function filesOfShard(files: string[], shard: string): string[] {
  const parts = /^(\d+)\/(\d+)$/.exec(shard);
  if (parts === null) {
    throw new Error(`run-lanes: give the shard as <index>/<count>, not ${shard}`);
  }
  const index = Number(parts[1]);
  const count = Number(parts[2]);
  if (count < 1 || index < 1 || index > count) {
    throw new Error(`run-lanes: the shard ${shard} is not one of 1/${count} to ${count}/${count}`);
  }
  return [...files].sort().filter((_, position) => position % count === index - 1);
}

/** The files that no lane took yet. A stop of the run empties it. */
const queue: string[] = [];
/** The signal that stopped the run. */
let stoppedBy: NodeJS.Signals | undefined;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { "file-limit-seconds": { type: "string" }, shard: { type: "string" } },
    allowPositionals: true,
  });
  const fileLimitSeconds = Number(values["file-limit-seconds"]);
  if (!(fileLimitSeconds > 0)) {
    throw new Error("run-lanes: give the time limit of a file (--file-limit-seconds <seconds>)");
  }
  if (positionals.length === 0) {
    throw new Error("run-lanes: name at least one spec file");
  }
  const files = values.shard === undefined ? positionals : filesOfShard(positionals, values.shard);
  queue.push(...files);
  const results: FileResult[] = [];
  const startedAt = Date.now();
  const lanes = Math.min(LANES, files.length);
  const bus = await startSessionBus();
  try {
    await Promise.all(
      Array.from({ length: lanes }, (_, index) =>
        runLane(index + 1, results, bus, fileLimitSeconds),
      ),
    );
  } finally {
    await stopServer(bus.server);
  }
  printTable(results, (Date.now() - startedAt) / 1000);
  if (stoppedBy !== undefined) {
    return 128 + (stoppedBy === "SIGINT" ? 2 : 15);
  }
  return results.some((result) => result.failed) ? 1 : 0;
}

// A stop ends the running files, and no lane takes another file. The
// unshare process of a file blocks SIGINT and SIGTERM while it waits for
// the file; SIGKILL ends it, and the first process of the namespaces with it
// (`--kill-child`), so no process of the file is left. A runner that SIGKILL
// ends runs no handler: the kernel ends its children (`ENDS_WITH_RUNNER`).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stoppedBy = signal;
    queue.length = 0;
    for (const child of running) {
      child.kill("SIGKILL");
    }
  });
}

// A rejection of the run ends the process with the error and exit code 1.
void main().then((code) => {
  process.exitCode = code;
});
