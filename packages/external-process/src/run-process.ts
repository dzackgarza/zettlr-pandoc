/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        runProcess
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Runs one external program and says how it ended. Each
 *                  run of an external tool in the main process goes through
 *                  this function, so each run has the same time limit
 *                  rules, the same stop of its processes and the same causes
 *                  of a failure.
 *
 * END HEADER
 */

import { type ChildProcess, spawn } from "child_process";
import { stat } from "fs/promises";

/** The time between SIGTERM and SIGKILL for a run that passed its limit. */
export const KILL_GRACE_MS = 2_000;

/** The time that a run may take, or `"none"` for a run without a limit. */
export type TimeLimit = number | "none";

export interface ProcessRequest {
  /** The program, a path or a name that the PATH of `env` resolves. */
  command: string;
  args: readonly string[];
  /** The environment of the program. A caller names it; nothing is read from the app. */
  env: NodeJS.ProcessEnv;
  /** The working directory. A folder that does not exist is a failure to start. */
  cwd?: string;
  /** The text on standard input. Without it, standard input is closed. */
  input?: string;
  timeLimitMs: TimeLimit;
  /**
   * `true`: the run ends when no process of its group is left, also a
   * process that the program started and that closed its output. `false`:
   * the run ends when the program and its output streams end; a process that
   * the program left running (a viewer that a command opened) goes on.
   */
  waitForGroup: boolean;
}

/** Why a program did not start. */
export type NotStarted =
  | { reason: "absent" }
  | { reason: "not-executable" }
  | { reason: "no-working-directory"; cwd: string; message: string }
  | { reason: "failed"; code: string; message: string };

export type ProcessOutcome =
  | { ended: "exit"; code: number; stdout: string; stderr: string }
  | { ended: "signal"; signal: NodeJS.Signals; stdout: string; stderr: string }
  | { ended: "timeout"; timeLimitMs: number; stdout: string; stderr: string }
  | ({ ended: "not-started" } & NotStarted);

// The runs that have not ended. Each run leads a process group of its own
// (`detached`), because a signal to one process does not reach the processes
// that it started (https://nodejs.org/api/child_process.html#subprocesskillsignal).
// A signal to the group reaches all of them, as `kill -- -PGID` does.
const activeRuns = new Set<ChildProcess>();

/**
 * Signals each process of a run. A group in which no process is left has
 * nothing to stop: kill(2) answers ESRCH for it, and that answer is no error
 * (https://man7.org/linux/man-pages/man2/kill.2.html).
 */
function signalGroup(run: ChildProcess, signal: NodeJS.Signals): void {
  if (run.pid === undefined) {
    return;
  }
  try {
    process.kill(-run.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

// A run is apart from the process group of the app, so a signal to the app
// does not reach it. The exit of the app stops the runs that have not ended.
process.on("exit", () => {
  for (const run of activeRuns) {
    signalGroup(run, "SIGKILL");
  }
});

/** The cause of a failed start, from the errno that Node gives for it. */
function notStarted(error: NodeJS.ErrnoException): NotStarted {
  if (error.code === "ENOENT") {
    return { reason: "absent" };
  }
  if (error.code === "EACCES") {
    return { reason: "not-executable" };
  }
  if (error.code === undefined) {
    throw new Error(
      `A child process failed to start with an error that has no errno code: ${error.message}`,
    );
  }
  return { reason: "failed", code: error.code, message: error.message };
}

/**
 * Runs one program. The promise settles when the run has ended; a time limit
 * that passes stops the group with SIGTERM and then with SIGKILL after
 * `KILL_GRACE_MS`. A program that ends by a signal or at the time limit
 * leaves no process of its group: the processes that it started have no
 * reader. The promise rejects only for a fault of this function, never for
 * an outcome of the program.
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessOutcome> {
  if (request.cwd !== undefined) {
    // spawn gives ENOENT for a working directory that does not exist, which
    // is the errno of a program that does not exist.
    const folder = await stat(request.cwd).catch((error: NodeJS.ErrnoException) => error);
    if (folder instanceof Error || !folder.isDirectory()) {
      return {
        ended: "not-started",
        reason: "no-working-directory",
        cwd: request.cwd,
        message: folder instanceof Error ? folder.message : `${request.cwd} is not a folder`,
      };
    }
  }

  return await new Promise<ProcessOutcome>((resolve) => {
    const child = spawn(request.command, [...request.args], {
      env: request.env,
      cwd: request.cwd,
      shell: false,
      detached: true,
      // The fourth pipe has no reader and no writer. Each process of the
      // group inherits it, and Node gives 'close' only after each pipe of the
      // child is closed (https://nodejs.org/api/child_process.html#event-close).
      stdio: [
        request.input === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
        ...(request.waitForGroup ? (["pipe"] as const) : []),
      ],
    });
    activeRuns.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const limitTimer =
      request.timeLimitMs === "none"
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            signalGroup(child, "SIGTERM");
            graceTimer = setTimeout(() => {
              signalGroup(child, "SIGKILL");
            }, KILL_GRACE_MS);
          }, request.timeLimitMs);
    const settle = (outcome: ProcessOutcome): void => {
      activeRuns.delete(child);
      clearTimeout(limitTimer);
      clearTimeout(graceTimer);
      resolve(outcome);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      // This function sends no signal through the child, no message and no
      // abort, so Node gives 'error' only for a process that did not start;
      // such a child has no pid
      // (https://nodejs.org/api/child_process.html#event-error).
      if (child.pid !== undefined) {
        throw new Error(`${request.command} gave an error after its start: ${error.message}`);
      }
      settle({ ended: "not-started", ...notStarted(error) });
    });
    child.once("exit", (_code, signal) => {
      if (signal !== null || timedOut) {
        signalGroup(child, "SIGKILL");
      }
    });
    child.once("close", (code, signal) => {
      if (child.pid === undefined) {
        return;
      }
      if (timedOut && request.timeLimitMs !== "none") {
        settle({ ended: "timeout", timeLimitMs: request.timeLimitMs, stdout, stderr });
      } else if (signal !== null) {
        settle({ ended: "signal", signal, stdout, stderr });
      } else if (code !== null) {
        settle({ ended: "exit", code, stdout, stderr });
      } else {
        throw new Error(
          `${request.command} closed with neither an exit code nor a signal; Node's 'close' event gives one of them.`,
        );
      }
    });
    if (child.stdin !== null && request.input !== undefined) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // EPIPE: the program closed its input before it read all of it. How
        // the program ended is the answer of the run.
        if (error.code !== "EPIPE") {
          throw error;
        }
      });
      child.stdin.end(request.input);
    }
  });
}

/** The sentence that names how a run that did not succeed ended. */
export function describeOutcome(command: string, outcome: ProcessOutcome): string {
  switch (outcome.ended) {
    case "exit": {
      const text = outcome.stderr.trim();
      return `${command} ended with exit code ${outcome.code}${text === "" ? "" : `: ${text}`}`;
    }
    case "signal":
      return `${command} was stopped by the signal ${outcome.signal}`;
    case "timeout":
      return `${command} did not end within ${formatDuration(outcome.timeLimitMs)}`;
    case "not-started":
      return describeNotStarted(command, outcome);
  }
}

/** The sentence that names why a program did not start. */
export function describeNotStarted(command: string, cause: NotStarted): string {
  switch (cause.reason) {
    case "absent":
      return `${command} is not on the PATH`;
    case "not-executable":
      return `${command} is on the PATH but not executable`;
    case "no-working-directory":
      return `${command} did not start: its working folder ${cause.cwd} cannot be used (${cause.message})`;
    case "failed":
      return `${command} did not start (${cause.code}: ${cause.message})`;
  }
}

/** A time limit as the author reads it. */
export function formatDuration(milliseconds: number): string {
  return milliseconds % 1000 === 0 ? `${milliseconds / 1000} s` : `${milliseconds} ms`;
}

/** A run that ended with an exit code. */
export type ProcessExit = Extract<ProcessOutcome, { ended: "exit" }>;

/**
 * The exit of a run whose exit code its caller reads. Each other outcome
 * throws an error whose message names the cause.
 */
export function requireExit(command: string, outcome: ProcessOutcome): ProcessExit {
  if (outcome.ended === "exit") {
    return outcome;
  }
  throw new Error(describeOutcome(command, outcome));
}

/**
 * The standard output of a run that ended with exit code 0. Each other
 * outcome throws an error whose message names the cause.
 */
export function requireSuccess(command: string, outcome: ProcessOutcome): string {
  if (outcome.ended === "exit" && outcome.code === 0) {
    return outcome.stdout;
  }
  throw new Error(describeOutcome(command, outcome));
}
