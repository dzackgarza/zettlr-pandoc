/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation resource problems of a window
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The citation provider cannot always load the files that
 *                  the settings `export.cslStyle` and `export.cslLibrary`
 *                  name, and the bibliographies that a document or a Quarto
 *                  book names. It starts before a window is open, so a window
 *                  reads the problems that exist and then follows each
 *                  change.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { CITEPROC_PROBLEMS_CHANNEL, type CitationResourceProblem } from "@dts/common/citeproc";
import { reportError } from "./error-reporting";

/**
 * Gives the problems that the citation provider has now, and each later list.
 */
export function followCitationProblems(
  onProblems: (problems: CitationResourceProblem[]) => void,
): void {
  // A broadcast is newer than the answer to the read below.
  let broadcastArrived = false;
  window.ipc.on(CITEPROC_PROBLEMS_CHANNEL, (_event, problems) => {
    broadcastArrived = true;
    onProblems(problems);
  });
  window.ipc
    .invoke("citeproc-provider", { command: "get-problems" })
    .then((problems: CitationResourceProblem[]) => {
      if (!broadcastArrived) {
        onProblems(problems);
      }
    })
    .catch((err) => reportError("Could not read the citation resource problems", err));
}

/**
 * The setting that names the file of a problem. No setting names a
 * bibliography: a document or the manifest of a Quarto book does.
 */
export function citationProblemSetting(
  problem: CitationResourceProblem,
): "export.cslStyle" | "export.cslLibrary" | undefined {
  if (problem.resource === "style") {
    return "export.cslStyle";
  }
  return problem.resource === "library" ? "export.cslLibrary" : undefined;
}

/** The sentence that names the file and the cause to the author. */
export function citationProblemMessage(problem: CitationResourceProblem): string {
  if (problem.resource === "style") {
    return trans(
      "The citation style %s could not be loaded: %s. No citation is rendered until the setting names a style that loads.",
      problem.path,
      problem.cause,
    );
  }
  return problem.resource === "library"
    ? trans("The citation library %s could not be loaded: %s", problem.path, problem.cause)
    : trans("The bibliography %s could not be loaded: %s", problem.path, problem.cause);
}
