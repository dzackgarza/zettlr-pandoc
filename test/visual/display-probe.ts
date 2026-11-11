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
 *                  the probe runs on a virtual one.
 *
 * END HEADER
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeOutput {
  stdout: string;
  stderr: string;
}

/** Runs the Node.js script `script` with `args` on a virtual X display. */
export async function runProbe(script: string, args: readonly string[]): Promise<ProbeOutput> {
  return await execFileAsync("xvfb-run", ["-a", "node", script, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
}
