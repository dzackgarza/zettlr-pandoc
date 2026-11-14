/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Messages for the problems that stand
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A provider gives a window the list of the files of the
 *                  settings that it could not load, and each later list. The
 *                  window shows one problem one time while it stands.
 *
 * END HEADER
 */

/**
 * The Preferences window writes a setting at each key. The problem of a path
 * that the author did not finish is not shown: the window shows the list
 * that stands after this time.
 */
const SETTLE_MS = 1000;

/**
 * Shows the problems of a provider in this window: the ones of the start, and
 * each one that a later setting causes.
 *
 * @param  follow  Gives the list that the provider has now, and each later list
 * @param  show    Shows one problem to the author
 */
export function showStandingProblems<Problem>(
  follow: (onProblems: (problems: Problem[]) => void) => void,
  show: (problem: Problem) => void,
): void {
  const shown = new Set<string>();
  let settle: ReturnType<typeof setTimeout> | undefined;

  follow((problems) => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const standing = new Map(problems.map((problem) => [JSON.stringify(problem), problem]));
      for (const key of shown) {
        if (!standing.has(key)) {
          shown.delete(key);
        }
      }
      for (const [key, problem] of standing) {
        if (!shown.has(key)) {
          shown.add(key);
          show(problem);
        }
      }
    }, SETTLE_MS);
  });
}
