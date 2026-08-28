/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        flowmark format service (issue #26)
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Formats markdown text with flowmark, the canonical formatter
 *                  across the toolchain (ai-review-ci runs it on every commit,
 *                  so formatting in-editor keeps the buffer matching what the
 *                  commit hook would produce). flowmark is a uvx external tool
 *                  that rewrites files in place, so this writes the text to a
 *                  temp file, runs `flowmark --inplace --semantic ...` over it,
 *                  and reads the result back. The tool being absent is a typed
 *                  result the caller surfaces, never a silent no-op. The runner
 *                  command is injectable so the roundtrip can be proven without
 *                  reaching for the network.
 *
 * END HEADER
 */

import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

/**
 * The typed outcome of a format attempt. `ok: false` is a real domain state,
 * not a swallowed error: `flowmark-absent` means the runner binary could not be
 * launched at all, `flowmark-error` means it ran but reported failure.
 */
export type FlowmarkResult =
  | { ok: true; formatted: string }
  | { ok: false; kind: "flowmark-absent" | "flowmark-error" | "flowmark-timeout"; message: string };

/** The canonical flowmark invocation (issue #26). */
const FLOWMARK_COMMAND = "uvx";
const FLOWMARK_ARGS_PREFIX = [
  "--from",
  "git+https://github.com/dzackgarza/flowmark.git",
  "flowmark",
  "--inplace",
  "--nobackup",
  "--semantic",
  "--no-respect-gitignore",
];

/**
 * Production time bound for a single format. Finite so a wedged `uvx`/flowmark
 * (a stalled git fetch, a deadlocked process) can never hang the caller's save
 * or keystroke path forever, but generous: a COLD `uvx` run first fetches
 * flowmark from git, and the integration lane already allows 180s for that, so
 * the bound must sit comfortably above it to avoid killing a legitimately slow
 * first run. Steady-state formatting is far below this once uvx has cached.
 */
const FLOWMARK_TIMEOUT_MS = 300_000;

/**
 * Grace between the polite SIGTERM and the forced SIGKILL. Short: a cooperative
 * child exits on SIGTERM at once (the timer is then cleared); only a child that
 * ignores SIGTERM waits out the grace and is force-killed, so no process is
 * left orphaned regardless of how it handles signals.
 */
const KILL_GRACE_MS = 2_000;

export interface FlowmarkOptions {
  /** The runner binary (default: `uvx`). Injected in tests. */
  command?: string;
  /** Args placed before the temp-file path (default: the flowmark invocation). */
  argsPrefix?: string[];
  /** Environment for the child (default: the caller's `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Upper bound in milliseconds on a single format before the child is
   * terminated and a typed `flowmark-timeout` failure is returned (default:
   * {@link FLOWMARK_TIMEOUT_MS}). Injected short in tests to prove the bound.
   */
  timeoutMs?: number;
}

interface RunOutcome {
  ok: boolean;
  kind?: "flowmark-absent" | "flowmark-error" | "flowmark-timeout";
  message: string;
}

/** Runs the formatter process, distinguishing "could not launch" from "failed". */
async function runFormatter(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunOutcome> {
  return await new Promise<RunOutcome>((resolve) => {
    const stderr: string[] = [];
    // shell: false — argv arrives literally, so a temp path with spaces is
    // never re-tokenized. The command itself is still PATH-resolved by spawn.
    const proc = spawn(command, argv, { env, shell: false });

    let settled = false;
    let timedOut = false;
    let boundTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (outcome: RunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (boundTimer !== undefined) {
        clearTimeout(boundTimer);
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      resolve(outcome);
    };

    proc.stderr?.on("data", (data) => {
      stderr.push(String(data));
    });

    // Fires when the binary itself cannot be launched (e.g. ENOENT): absent.
    proc.on("error", (err) => {
      settle({ ok: false, kind: "flowmark-absent", message: err.message });
    });

    // A single 'close' is the only settle point once the child has been
    // launched: a normal exit, a non-zero exit, OR the exit that follows our
    // termination signal. Resolving here (rather than on the timer) guarantees
    // the child has actually exited and been reaped before we report a timeout,
    // so no process is left running behind the typed failure.
    proc.on("close", (code) => {
      if (timedOut) {
        settle({
          ok: false,
          kind: "flowmark-timeout",
          message: `flowmark did not complete within ${String(timeoutMs)}ms and was terminated`,
        });
      } else if (code === 0) {
        settle({ ok: true, message: "" });
      } else {
        settle({
          ok: false,
          kind: "flowmark-error",
          message: stderr.join("").trim() || `flowmark exited with code ${String(code)}`,
        });
      }
    });

    // The time bound: on expiry, terminate the child (SIGTERM, escalating to
    // SIGKILL after a short grace) and let the resulting 'close' settle the
    // typed timeout failure. Never resolves ok:true on timeout.
    boundTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}

/**
 * Formats markdown `text` with flowmark and returns the result. On success the
 * returned `formatted` string is the rewritten temp file's bytes.
 *
 * @param   text  The markdown source to format.
 * @param   opts  Runner overrides (mainly for tests).
 *
 * @return        A typed FlowmarkResult.
 */
export async function formatMarkdownText(
  text: string,
  opts: FlowmarkOptions = {},
): Promise<FlowmarkResult> {
  const command = opts.command ?? FLOWMARK_COMMAND;
  const argsPrefix = opts.argsPrefix ?? FLOWMARK_ARGS_PREFIX;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? FLOWMARK_TIMEOUT_MS;

  const dir = await mkdtemp(path.join(tmpdir(), "zettlr-flowmark-"));
  const file = path.join(dir, "document.md");

  try {
    await writeFile(file, text, "utf-8");
    const outcome = await runFormatter(command, [...argsPrefix, file], env, timeoutMs);
    if (!outcome.ok) {
      return { ok: false, kind: outcome.kind ?? "flowmark-error", message: outcome.message };
    }
    const formatted = await readFile(file, "utf-8");
    return { ok: true, formatted };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
