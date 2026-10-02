/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        updateFlowmark
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Installs or upgrades the `flowmark` uv tool from the main
 *                  branch of dzackgarza/pandoc-flowmark, so the editor always
 *                  formats and lints with the newest Flowmark.
 *
 * END HEADER
 */

import { type FlowmarkProcessResult, runFlowmarkProcess } from "./flowmark-runtime";

// `just install-flowmark` installs the same source for CI and the test lanes.
const FLOWMARK_SOURCE = "flowmark @ git+https://github.com/dzackgarza/pandoc-flowmark@main";

/**
 * Run `uv tool install --upgrade` for Flowmark main. With no new commit on
 * main this is a no-op that takes a few seconds; a failure (no network, a
 * broken build on main) leaves the installed tool unchanged.
 */
export async function updateFlowmark(): Promise<FlowmarkProcessResult> {
  return await runFlowmarkProcess({
    command: "uv",
    argv: ["tool", "install", "--upgrade", FLOWMARK_SOURCE],
    timeoutMs: 300_000,
  });
}
