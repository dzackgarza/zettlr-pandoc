/**
 * Runs assembled-app spec files in lanes (#70).
 *
 * Each spec file starts the app, and a run of the files one after the other
 * takes the sum of their times. The runner runs `LANES` files at the same
 * time. A lane owns one virtual X display (Xvfb), and a spec file of the lane
 * runs on that display alone: a native message box, a key that `xdotool`
 * presses and the focus of a window are not shared with the spec of another
 * lane. Each file runs in a Mocha process of its own, so a file that leaves a
 * handle open stops no other file. The process gets the number of its lane
 * in `E2E_LANE`; a start that compiles the app takes its Forge ports from it
 * (`forgePortsOfLane`, `electron-app.ts`). Each file gets the source
 * fingerprint of the start of the run in `E2E_SOURCE_FINGERPRINT`.
 *
 * The output of a file is printed whole when the file ends, with the time of
 * the file. After the last file the runner prints each file by time, the
 * slowest first, with its result, and the wall time of the run. The runner
 * exits 1 when a file failed.
 *
 * Usage: node --import tsx e2e/support/run-lanes.ts <spec file>...
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { Readable } from "node:stream";

/**
 * Three apps at a time: the hosted runner has 4 processors and 16 GB, and
 * each lane holds one app and its Mocha process. On the workstation the run
 * shares 15 GB with the desktop of the author.
 */
const LANES = 3;

/** A test or a hook has 90 s (AGENTS.md §13). */
const MOCHA_ARGS = ["--no-config", "--node-option", "import=tsx", "--timeout", "90000"];

interface FileResult {
  file: string;
  lane: number;
  seconds: number;
  /** The exit code of Mocha (the count of failed tests), or the signal that ended it. */
  outcome: string;
  failed: boolean;
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
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  let errors = "";
  server.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const numbers = server.stdio[3] as Readable;
  let written = "";
  const number = await new Promise<string>((resolve, reject) => {
    numbers.on("data", (chunk: Buffer) => {
      written += chunk.toString();
      if (written.includes("\n")) {
        resolve(written.trim());
      }
    });
    server.once("error", reject);
    server.once("exit", (code, signal) => {
      reject(new Error(`Xvfb ended before it had a display (${code ?? signal}): ${errors}`));
    });
  });
  return { name: `:${number}`, server };
}

async function stopDisplay(display: Display): Promise<void> {
  if (display.server.exitCode !== null || display.server.signalCode !== null) {
    return;
  }
  const exited = once(display.server, "exit");
  display.server.kill("SIGTERM");
  await exited;
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

async function runFile(file: string, lane: number, display: Display): Promise<FileResult> {
  const mocha = path.join(process.cwd(), "node_modules", ".bin", "mocha");
  const startedAt = Date.now();
  const child = spawn(mocha, [...MOCHA_ARGS, file], {
    env: {
      ...process.env,
      DISPLAY: display.name,
      E2E_LANE: String(lane),
      E2E_SOURCE_FINGERPRINT: sourceFingerprint,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  const output: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  running.delete(child);
  const seconds = (Date.now() - startedAt) / 1000;
  const outcome = signal === null ? `exit ${code}` : signal;
  process.stdout.write(
    `\n== ${file} (lane ${lane}, ${seconds.toFixed(1)} s, ${outcome})\n${Buffer.concat(output).toString()}`,
  );
  return { file, lane, seconds, outcome, failed: code !== 0 };
}

async function runLane(lane: number, results: FileResult[]): Promise<void> {
  const display = await startDisplay();
  try {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      results.push(await runFile(file, lane, display));
    }
  } finally {
    await stopDisplay(display);
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

/** The files that no lane took yet. A stop of the run empties it. */
const queue: string[] = [];
/** The signal that stopped the run. */
let stoppedBy: NodeJS.Signals | undefined;

async function main(files: string[]): Promise<number> {
  if (files.length === 0) {
    throw new Error("run-lanes: name at least one spec file");
  }
  queue.push(...files);
  const results: FileResult[] = [];
  const startedAt = Date.now();
  const lanes = Math.min(LANES, files.length);
  await Promise.all(Array.from({ length: lanes }, (_, index) => runLane(index + 1, results)));
  printTable(results, (Date.now() - startedAt) / 1000);
  if (stoppedBy !== undefined) {
    return 128 + (stoppedBy === "SIGINT" ? 2 : 15);
  }
  return results.some((result) => result.failed) ? 1 : 0;
}

// A stop ends the running files, and no lane takes another file.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stoppedBy = signal;
    queue.length = 0;
    for (const child of running) {
      child.kill(signal);
    }
  });
}

// A rejection of the run ends the process with the error and exit code 1.
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
