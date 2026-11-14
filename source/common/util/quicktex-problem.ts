/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        QuickTeX problem of a window
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The assets provider cannot always use the QuickTeX
 *                  configuration that the settings `editor.quickTexFile` and
 *                  `editor.quickTexPluginDirectory` name. It reads the
 *                  configuration before a window is open, so a window reads
 *                  the problem that exists and then follows each change.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { QuickTexProblem } from "@dts/common/quicktex";
import { reportError } from "./error-reporting";

/**
 * Gives the problem that the QuickTeX configuration has now, and the problem
 * after each later read. A configuration that loads has none.
 */
export function followQuickTexProblem(
  onProblem: (problem: QuickTexProblem | undefined) => void,
): void {
  const read = (): void => {
    window.ipc
      .invoke("assets-provider", { command: "get-quicktex" })
      .then((catalogue) => onProblem(catalogue.problem))
      .catch((err) => reportError("Could not read the QuickTeX configuration", err));
  };
  window.ipc.on("assets-provider", (_event, what) => {
    if (what === "quicktex-updated") {
      read();
    }
  });
  read();
}

/** The sentence that names the cause to the author. The cause names the file. */
export function quickTexProblemMessage(problem: QuickTexProblem): string {
  return trans("QuickTeX is not available: %s", problem.cause);
}
