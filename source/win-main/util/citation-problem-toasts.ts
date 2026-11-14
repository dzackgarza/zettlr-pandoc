/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation resource problem messages of the main window
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Shows each file that the citation provider did not
 *                  load as an error. A file of the citation settings has the
 *                  action that opens its setting.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import {
  citationProblemMessage,
  citationProblemSetting,
  followCitationProblems,
} from "@common/util/citation-problems";
import { reportError } from "@common/util/error-reporting";
import showToast from "@common/util/show-toast";
import type { CitationResourceProblem } from "@dts/common/citeproc";
import { type PreferenceNavigationTarget, PreferencesGroups } from "@dts/common/preferences";
import { showStandingProblems } from "./standing-problem-toasts";

/**
 * Shows the citation resource problems of the provider in this window: the
 * ones of the start, and each one that a later setting causes.
 */
export function showCitationProblems(): void {
  showStandingProblems(followCitationProblems, showProblem);
}

function showProblem(problem: CitationResourceProblem): void {
  const setting = citationProblemSetting(problem);
  if (setting === undefined) {
    // A document or a Quarto manifest names this file. The message names it.
    showToast(citationProblemMessage(problem), "error", 12000);
    return;
  }
  const target: PreferenceNavigationTarget = {
    group: PreferencesGroups.Citations,
    model: setting,
  };
  showToast(citationProblemMessage(problem), "error", 12000, {
    label: trans("Open Preferences"),
    onAction: () => {
      window.ipc
        .invoke("application", { command: "open-preferences", payload: target })
        .catch((err) => reportError("Could not open the Preferences window", err));
    },
  });
}
