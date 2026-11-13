/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the citation tab schema.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { citationProblemSetting } from "@common/util/citation-problems";
import type { CitationResourceProblem } from "@dts/common/citeproc";
import type { ConfigOptions } from "source/app/service-providers/config/get-config-template";
import { PreferencesGroups } from "./_preferences-groups";
import { type PreferencesFieldset } from "./types";

/**
 * @param  config    The settings that the form shows
 * @param  problems  The files of those settings that the citation provider
 *                   could not load
 */
export function getCitationFields(
  config: ConfigOptions,
  problems: CitationResourceProblem[],
): PreferencesFieldset[] {
  // A problem belongs to the path that the provider tried. While the author
  // types another path, the field has no problem of its own yet.
  const problemOf = (setting: "export.cslStyle" | "export.cslLibrary"): string | undefined => {
    const value = setting === "export.cslStyle" ? config.export.cslStyle : config.export.cslLibrary;
    const problem = problems.find(
      (candidate) => citationProblemSetting(candidate) === setting && candidate.path === value,
    );
    return problem === undefined
      ? undefined
      : trans("The app could not load this file: %s", problem.cause);
  };

  return [
    {
      title: trans("Citations"),
      group: PreferencesGroups.Citations,
      help: undefined, // TODO
      fields: [
        {
          type: "radio",
          label: trans("How would you like autocomplete to insert your citations?"),
          model: "editor.citeStyle",
          options: {
            regular: trans("%s renders as %s", "[@Author2015, p. 123]", "(Author 2015, 123)"),
            "in-text": trans("%s renders as %s", "@Author2015", "Author (2015)"),
            "in-text-suffix": trans(
              "%s renders as %s",
              "@Author2015 [p. 123]",
              "Author (2015, 123)",
            ),
          },
        },
        { type: "separator" },
        {
          type: "file",
          label: trans("Citation database (CSL JSON or BibTex)"),
          model: "export.cslLibrary",
          placeholder: trans("Path to file"),
          reset: "",
          filter: [
            { extensions: ["json", "yaml", "yml", "bib"], name: "CSL JSON or BibTeX" },
            { extensions: ["json", "yaml", "yml"], name: "CSL JSON" },
            { extensions: ["bib"], name: "BibTeX" },
          ],
          problem: problemOf("export.cslLibrary"),
        },
        {
          type: "file",
          label: trans(
            "CSL style of the editor and of the Pandoc exports (optional; not the PDF recipe)",
          ),
          model: "export.cslStyle",
          placeholder: trans("Path to file"),
          reset: "",
          filter: [{ extensions: ["csl"], name: "CSL Style" }],
          problem: problemOf("export.cslStyle"),
        },
      ],
    },
  ];
}
