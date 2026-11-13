/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Display probe runner
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A spec that needs Chromium starts a probe: a Node.js
 *                  process that opens the page and reports what it sees.
 *                  Chromium needs an X display, and a test run has none, so
 *                  the probe runs on a virtual one. A probe that fails gives
 *                  an error with its exit status and all of its output,
 *                  because a failure that occurs once on a hosted runner
 *                  leaves no other evidence.
 *
 * END HEADER
 */

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The default screen of xvfb-run is not the same in all distributions
// (640x480 on Arch Linux, 1280x1024 on Ubuntu). A probe gets the screen of
// the hosted runner on each machine.
const PROBE_SCREEN = "1280x1024x24";

export interface ProbeOutput {
  stdout: string;
  stderr: string;
}

/** A command on a virtual display that did not end with status 0. */
export class DisplayCommandFailure extends Error {
  constructor(
    readonly command: readonly string[],
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly xServerOutput: string,
  ) {
    super(
      [
        `Command failed on a virtual display: ${command.join(" ")}`,
        exitCode === null ? `Signal: ${String(signal)}` : `Exit code: ${String(exitCode)}`,
        "--- stdout ---",
        stdout,
        "--- stderr ---",
        stderr,
        "--- X server ---",
        xServerOutput,
      ].join("\n"),
    );
    this.name = "DisplayCommandFailure";
  }
}

/**
 * Runs `command` on a virtual X display with the screen `screen`
 * (`<width>x<height>x<depth>`).
 *
 * xvfb-run discards what the X server and xauth write unless it has an error
 * file (`--error-file`). It opens that file by name more than once, and the
 * xvfb-run of Arch Linux truncates it at the end of the run. A FIFO has no
 * content to truncate, so the error file is a FIFO that this function reads.
 *
 * The shell of xvfb-run gives 128 plus the signal number as the exit code of
 * a command that a signal ended, and the xvfb-run of Ubuntu joins the error
 * output of the command to its output.
 */
export async function runOnVirtualDisplay(
  screen: string,
  command: string,
  args: readonly string[],
): Promise<ProbeOutput> {
  const directory = await mkdtemp(path.join(tmpdir(), "zettlr-virtual-display-"));
  const errorFile = path.join(directory, "x-server");
  await execFileAsync("mkfifo", [errorFile]);
  const commandLine = [
    "xvfb-run",
    "--auto-servernum",
    `--error-file=${errorFile}`,
    `--server-args=-screen 0 ${screen}`,
    command,
    ...args,
  ];
  // A FIFO gives its reader the end of the data when its last writer closed
  // it (fifo(7)). This process is a writer until the run has ended, so the
  // end comes only after the X server and xauth are gone.
  const xServer = new Socket({
    fd: openSync(errorFile, constants.O_RDONLY | constants.O_NONBLOCK),
    readable: true,
    writable: false,
  });
  const writer = openSync(errorFile, constants.O_WRONLY);
  const xServerOutput = text(xServer);
  const run = spawn(commandLine[0], commandLine.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = text(run.stdout);
  const stderr = text(run.stderr);
  // `close` comes after the process ended and its streams are complete
  // (https://nodejs.org/api/child_process.html#event-close).
  const [exitCode, signal] = (await once(run, "close")) as [number | null, NodeJS.Signals | null];
  closeSync(writer);
  const output = { stdout: await stdout, stderr: await stderr };
  const serverOutput = await xServerOutput;
  await rm(directory, { recursive: true });
  if (exitCode !== 0) {
    throw new DisplayCommandFailure(
      commandLine,
      exitCode,
      signal,
      output.stdout,
      output.stderr,
      serverOutput,
    );
  }
  return output;
}

/** Runs the Node.js script `script` with `args` on a virtual X display. */
export async function runProbe(script: string, args: readonly string[]): Promise<ProbeOutput> {
  return await runOnVirtualDisplay(PROBE_SCREEN, "node", [script, ...args]);
}
