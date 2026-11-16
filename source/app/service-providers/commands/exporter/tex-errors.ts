/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        texErrorsOfRecipeRun
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The PDF recipe of ~/.pandoc runs latexmk in force mode
 *                  (`_compile-pandoc-latexmk`). For a document with a TeX
 *                  error that still gives a PDF it keeps the PDF, prints one
 *                  report and ends with exit code 0. This function reads the
 *                  errors of TeX from the output of such a run.
 *
 * END HEADER
 */

/** The report of the recipe for a PDF that latexmk wrote with errors. */
const RECIPE_REPORT = /latexmk exited (\d+) but PDF was produced/;

/** An error of TeX starts a line with this. */
const ERROR_MARK = "! ";

/** The line of the TeX file at which an error is, as TeX prints it. */
const ERROR_LINE = /^l\.\d+ /;

/**
 * The line `l.<number> <text>` of the error that starts at `start`: the first
 * such line before the next error. TeX prints the context of the error
 * between the two.
 */
function lineOfError(output: string[], start: number): string | undefined {
  for (let index = start + 1; index < output.length; index += 1) {
    const line = output[index];
    if (line.startsWith(ERROR_MARK)) {
      return undefined;
    }
    if (ERROR_LINE.test(line)) {
      return line.trimEnd();
    }
  }
  return undefined;
}

/**
 * The errors that TeX reported in a run of the PDF recipe that still wrote
 * its PDF. The recipe decides whether TeX failed: without its report the run
 * has no error. latexmk runs TeX more than one time, so each error is given
 * one time, in the order of the output. A run whose report comes with no
 * error of TeX gives the exit code of latexmk.
 *
 * @param   {string[]}  output  The standard output of the recipe, by line
 *
 * @return  {string[]}          One entry for each error; empty for a run
 *                              without the report of the recipe
 */
export function texErrorsOfRecipeRun(output: string[]): string[] {
  let exitCode: string | undefined;
  for (const line of output) {
    const report = RECIPE_REPORT.exec(line);
    if (report !== null) {
      exitCode = report[1];
    }
  }
  if (exitCode === undefined) {
    return [];
  }

  const errors = new Set<string>();
  for (const [index, line] of output.entries()) {
    if (!line.startsWith(ERROR_MARK)) {
      continue;
    }
    const message = line.slice(ERROR_MARK.length).trim();
    const place = lineOfError(output, index);
    errors.add(place === undefined ? message : `${message} ${place}`);
  }
  if (errors.size === 0) {
    return [`latexmk ended with the exit code ${exitCode}.`];
  }
  return [...errors];
}
