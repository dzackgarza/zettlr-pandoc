/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        probeTool
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Finds out whether an external tool answers on a PATH. A
 *                  probe runs `<tool> --version` one time with a time limit.
 *                  A probe that found its tool is kept for the PATH, so each
 *                  part of the app that asks gets the same answer and the
 *                  tool starts one time.
 *
 * END HEADER
 */

import { describeNotStarted, formatDuration, type NotStarted, runProcess } from "./run-process";

/** The time that `<tool> --version` may take. */
export const PROBE_TIME_LIMIT_MS = 10_000;

export type ToolProbe =
  /** The tool ran and ended. Its exit code does not count; its output is its version text. */
  | { status: "available"; versionOutput: string }
  | ({ status: "not-started" } & NotStarted)
  | { status: "no-answer"; timeLimitMs: number }
  | { status: "stopped"; signal: NodeJS.Signals };

/**
 * The probes that found their tool or that run, by PATH and tool name. A
 * tool that was found stays installed while the app runs. A tool that was
 * not found is probed again at the next request: the author may install it
 * while the app stays open.
 */
const probes = new Map<string, Promise<ToolProbe>>();

async function runProbe(tool: string, env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  const outcome = await runProcess({
    command: tool,
    args: ["--version"],
    env,
    timeLimitMs: PROBE_TIME_LIMIT_MS,
    waitForGroup: false,
  });
  switch (outcome.ended) {
    case "exit":
      return { status: "available", versionOutput: outcome.stdout };
    case "signal":
      return { status: "stopped", signal: outcome.signal };
    case "timeout":
      return { status: "no-answer", timeLimitMs: outcome.timeLimitMs };
    case "not-started": {
      const { ended: _ended, ...cause } = outcome;
      return { ...cause, status: "not-started" };
    }
  }
}

/** Probes `tool` on the PATH of `env`, one time for each PATH while the tool is found. */
export async function probeTool(tool: string, env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  if (env.PATH === undefined) {
    throw new Error(`The environment has no PATH, so ${tool} cannot be found in it.`);
  }
  const key = `${env.PATH}\0${tool}`;
  const known = probes.get(key);
  if (known !== undefined) {
    return await known;
  }
  const probe = runProbe(tool, env);
  probes.set(key, probe);
  const result = await probe.catch((error: unknown) => {
    probes.delete(key);
    throw error;
  });
  if (result.status !== "available") {
    probes.delete(key);
  }
  return result;
}

/** The sentence that names why a probe did not find its tool. */
export function describeProbe(
  tool: string,
  probe: Exclude<ToolProbe, { status: "available" }>,
): string {
  switch (probe.status) {
    case "not-started":
      return describeNotStarted(tool, probe);
    case "no-answer":
      return `${tool} did not answer --version within ${formatDuration(probe.timeLimitMs)}`;
    case "stopped":
      return `${tool} --version was stopped by the signal ${probe.signal}`;
  }
}
