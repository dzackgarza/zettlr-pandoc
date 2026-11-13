/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark process runtime
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single main-process execution seam for Flowmark.
 *                  Formatting and linting run the `flowmark` and
 *                  `flowmark-lint` commands of the uv tool that the app
 *                  upgrades from Flowmark's main branch at every start
 *                  (flowmark-update.ts).  Nothing in Zettlr owns a Markdown
 *                  grammar.
 *
 * END HEADER
 */

import { describeOutcome, runProcess } from "@dzack/external-process/run-process";
import { existsSync } from "fs";
import path from "path";

export type FlowmarkProcessFailureKind = "flowmark-absent" | "flowmark-error" | "flowmark-timeout";

export type FlowmarkProcessResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; kind: FlowmarkProcessFailureKind; message: string };

/** Locate a packaged/development external-linter process plugin. */
export function externalLinterPluginPath(filename: string): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath !== undefined) {
    const packaged = path.join(resourcesPath, "linter-plugins", filename);
    if (existsSync(packaged)) {
      return packaged;
    }
  }
  return path.resolve("linter-plugins", filename);
}

/**
 * The Python interpreter of the installed `flowmark` uv tool. A process
 * plugin that imports Flowmark (LanguageTool's) runs under it, so it sees the
 * same Flowmark as the `flowmark` and `flowmark-lint` commands.
 */
export async function flowmarkToolPython(): Promise<string> {
  toolPython ??= locateToolPython();
  try {
    return await toolPython;
  } catch (error) {
    toolPython = undefined;
    throw error;
  }
}

// uv derives its tool directory from the environment of this process, which
// does not change while the app runs. One `uv tool dir` process answers for
// the session; a failed one is asked again.
let toolPython: Promise<string> | undefined;

async function locateToolPython(): Promise<string> {
  const outcome = await runFlowmarkProcess({
    command: "uv",
    argv: ["tool", "dir"],
    timeoutMs: 30_000,
  });
  if (!outcome.ok) {
    throw new Error(`Cannot locate the uv tool directory: ${outcome.message}`);
  }
  return path.join(outcome.stdout.trim(), "flowmark", "bin", "python");
}

// PEP 610 records the source of a direct install, for a Git install the
// resolved commit, in the distribution's direct_url.json.
const INSTALL_IDENTITY_SCRIPT = [
  "import importlib.metadata as m",
  'd = m.distribution("flowmark")',
  'print(d.version, d.read_text("direct_url.json") or "")',
].join("\n");

/**
 * The exact installed Flowmark: its version and, for the Git install the app
 * maintains, the commit uv resolved. Lint results computed by one install do
 * not carry over to another.
 */
export async function flowmarkInstallIdentity(): Promise<string> {
  const outcome = await runFlowmarkProcess({
    command: await flowmarkToolPython(),
    argv: ["-c", INSTALL_IDENTITY_SCRIPT],
    timeoutMs: 30_000,
  });
  if (!outcome.ok) {
    throw new Error(`Cannot identify the installed Flowmark: ${outcome.message}`);
  }
  return outcome.stdout.trim();
}

export interface FlowmarkProcessOptions {
  command: string;
  argv: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * Run one Flowmark process with bounded lifetime and captured stdio.
 *
 * The process is spawned without a shell through `runProcess`. On timeout the
 * process and the processes that it started (the Pandoc of `flowmark-lint`)
 * receive SIGTERM, then SIGKILL after a short grace, and the promise resolves
 * only after the child has actually closed.
 */
export async function runFlowmarkProcess(
  options: FlowmarkProcessOptions,
): Promise<FlowmarkProcessResult> {
  const outcome = await runProcess({
    command: options.command,
    args: options.argv,
    env: options.env ?? process.env,
    input: options.input,
    timeLimitMs: options.timeoutMs,
    waitForGroup: false,
  });
  switch (outcome.ended) {
    case "exit":
      if (outcome.code === 0) {
        return { ok: true, stdout: outcome.stdout, stderr: outcome.stderr };
      }
      return {
        ok: false,
        kind: "flowmark-error",
        message: outcome.stderr.trim() || describeOutcome(options.command, outcome),
      };
    case "timeout":
      return {
        ok: false,
        kind: "flowmark-timeout",
        message: describeOutcome(options.command, outcome),
      };
    case "not-started":
      return {
        ok: false,
        kind: outcome.reason === "absent" ? "flowmark-absent" : "flowmark-error",
        message: describeOutcome(options.command, outcome),
      };
    case "signal":
      return {
        ok: false,
        kind: "flowmark-error",
        message: describeOutcome(options.command, outcome),
      };
  }
}
