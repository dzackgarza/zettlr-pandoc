/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The TeX errors of a run of the PDF recipe
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The PDF recipe keeps the PDF of a document with a TeX
 *                  error and ends with exit code 0; its output has the errors
 *                  of TeX and one report of the recipe. `texErrorsOfRecipeRun`
 *                  reads the errors from that output, so the export can show
 *                  them to the author (#47).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { texErrorsOfRecipeRun } from "source/app/service-providers/commands/exporter/tex-errors";
import { RECIPE_OUTPUT_WITH_TEX_ERROR } from "./recording-just";

const REPORT = "⚠️  latexmk exited 12 but PDF was produced — check warnings above";

describe("The TeX errors of a run of the PDF recipe", function () {
  it("gives the error of each TeX run one time, with its line", function () {
    assert.deepEqual(texErrorsOfRecipeRun(RECIPE_OUTPUT_WITH_TEX_ERROR.split("\n")), [
      "Undefined control sequence. l.117 \\undefinedmacro",
    ]);
  });

  it("gives each error in the order of the output", function () {
    const output = [
      "! Undefined control sequence.",
      "<argument> \\genus ",
      "l.40 \\section{\\genus}",
      "! Missing $ inserted.",
      "<inserted text> ",
      "                $",
      "l.52 The form x_",
      "                1 is even.",
      REPORT,
    ];

    assert.deepEqual(texErrorsOfRecipeRun(output), [
      "Undefined control sequence. l.40 \\section{\\genus}",
      "Missing $ inserted. l.52 The form x_",
    ]);
  });

  it("gives an error that has no line", function () {
    const output = ["! Emergency stop.", "! Undefined control sequence.", "l.7 \\rank", REPORT];

    assert.deepEqual(texErrorsOfRecipeRun(output), [
      "Emergency stop.",
      "Undefined control sequence. l.7 \\rank",
    ]);
  });

  it("gives the exit code of latexmk when the output has no error of TeX", function () {
    assert.deepEqual(texErrorsOfRecipeRun(["Latexmk: Errors, in force_mode", REPORT]), [
      "latexmk ended with the exit code 12.",
    ]);
  });

  it("gives nothing for a run that the recipe does not report", function () {
    const output = [
      "Latexmk: applying rule 'pdflatex'...",
      "Overfull \\hbox (4.2pt too wide) in paragraph at lines 12--14",
      "Latexmk: All targets (output.pdf) are up-to-date",
    ];

    assert.deepEqual(texErrorsOfRecipeRun(output), []);
  });
});
