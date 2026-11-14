/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        QuickTeX problem message of the main window
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Shows a QuickTeX configuration that the assets provider
 *                  did not load as an error, with the action that opens its
 *                  setting.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { followQuickTexProblem, quickTexProblemMessage } from "@common/util/quicktex-problem";
import showToast from "@common/util/show-toast";
import { type PreferenceNavigationTarget, PreferencesGroups } from "@dts/common/preferences";
import type { QuickTexProblem } from "@dts/common/quicktex";
import { showStandingProblems } from "./standing-problem-toasts";

/**
 * Shows the problem of the QuickTeX configuration in this window: the one of
 * the start, and each one that a later setting causes.
 */
export function showQuickTexProblem(): void {
  showStandingProblems<QuickTexProblem>(
    (onProblems) =>
      followQuickTexProblem((problem) => onProblems(problem === undefined ? [] : [problem])),
    showProblem,
  );
}

function showProblem(problem: QuickTexProblem): void {
  const target: PreferenceNavigationTarget = {
    group: PreferencesGroups.Snippets,
    model: problem.setting,
  };
  showToast(quickTexProblemMessage(problem), "error", 12000, {
    label: trans("Open Preferences"),
    onAction: () => {
      window.ipc
        .invoke("application", { command: "open-preferences", payload: target })
        .catch((err) => reportError("Could not open the Preferences window", err));
    },
  });
}
