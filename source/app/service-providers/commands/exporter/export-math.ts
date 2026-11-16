/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The places of the math of a Pandoc export
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The template of an export owns its math: the MathJax
 *                  configuration with the macros of an HTML page, the
 *                  packages of a TeX document. The templates of ~/.pandoc
 *                  hold the macros that `bin/generate-mathjax-config.py`
 *                  writes from `styles/macros`. The application assembles
 *                  no configuration and no preamble. It gives an HTML export
 *                  the places of the copy of MathJax that it brings
 *                  (`scripts/export-mathjax.js`) and nothing else: the
 *                  component that the page loads, the folder of that
 *                  component, and the folder of the MathJax font packages.
 *                  A template reads the two folders as the Pandoc variables
 *                  `mathjax-root` and `mathjax-fonts`. A page that embeds
 *                  the component (a self-contained export) cannot tell the
 *                  folder from the address of the component, so the folder
 *                  has a variable of its own. An exported page then needs
 *                  no network.
 *
 * END HEADER
 */

import { isHtmlWriter } from "@common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "@common/pandoc-util/parse-reader-writer";
import path from "path";
import { pathToFileURL } from "url";

/** The Pandoc variable that a template of ~/.pandoc reads for the folder of the MathJax component. */
export const MATHJAX_ROOT_VARIABLE = "mathjax-root";
/** The Pandoc variable that a template of ~/.pandoc reads for the MathJax font packages. */
export const MATHJAX_FONTS_VARIABLE = "mathjax-fonts";

export interface ExportMath {
  /** The folder of the MathJax of an HTML export (`scripts/export-mathjax.js`). */
  mathJaxDirectory: string;
  /** The ~/.pandoc directory, whose templates own the math of an export. */
  pandocDirectory: string;
}

/** The variables of a defaults file, as a record. */
function variablesOf(defaults: Record<string, unknown>): Record<string, unknown> {
  const variables = defaults.variables;
  if (variables === undefined) {
    return {};
  }
  if (variables instanceof Object && !Array.isArray(variables)) {
    return { ...variables };
  }
  throw new TypeError("Pandoc variables must be a mapping of names to values");
}

/**
 * Names the MathJax of the application in the defaults of an HTML export.
 * The defaults of another writer stay as they are.
 */
export function setMathPlaces(defaults: Record<string, unknown>, math: ExportMath): void {
  const writer = parseReaderWriter(defaults.writer as string).name;
  if (!isHtmlWriter(writer)) {
    return;
  }
  const fileUrl = (name: string): string =>
    pathToFileURL(path.join(math.mathJaxDirectory, name)).href;
  // Pandoc writes each formula as TeX between \( \) or \[ \]; the template
  // loads this component, which typesets all of them.
  defaults["html-math-method"] = { method: "mathjax", url: fileUrl("tex-chtml.js") };
  defaults.variables = {
    ...variablesOf(defaults),
    [MATHJAX_ROOT_VARIABLE]: pathToFileURL(math.mathJaxDirectory).href,
    [MATHJAX_FONTS_VARIABLE]: fileUrl("fonts"),
  };
}
