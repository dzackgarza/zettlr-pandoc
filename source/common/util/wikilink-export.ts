/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Wikilink resolutions for an export
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Resolves the wikilinks of the files an export reads, for
 *                  pandoc-config's filters/wikilinks.lua. Zettlr is the only
 *                  resolver; the filter applies what this map says.
 *
 * END HEADER
 */

import { extractASTNodes, markdownToAST } from "../modules/markdown-utils";
import type { Heading, ZettelkastenLink } from "../modules/markdown-utils/markdown-ast";
import { fragmentHeadingIndex, type WikilinkIndex } from "./wikilink-resolution";
import { splitWikilinkTarget } from "./wikilink-target";

/** One file of the export, in the order pandoc reads it. */
export interface ExportInput {
  path: string;
  markdown: string;
}

/** The heading that a wikilink leads to: an input and a heading in it. */
export interface WikilinkDestination {
  /** The 0-based index of the input. */
  input: number;
  /** The 0-based index of the heading in that input. */
  heading: number;
}

/**
 * The JSON file that filters/wikilinks.lua reads. `links` maps the raw target
 * of a wikilink, the text before its `|`, to its destination. A wikilink
 * whose target names no document of the export is not in it.
 */
export interface WikilinkExportMap {
  inputs: Array<{ headings: number }>;
  links: Record<string, WikilinkDestination>;
}

/**
 * Resolves every wikilink of `inputs` that names a document of the export. A
 * link without a `#heading` leads to the first heading of its document; a
 * link whose `#heading` names no heading is left out. Throws when the same
 * raw target leads to two destinations, or a link leads to a document with no
 * heading.
 */
export function wikilinkExportMap(inputs: ExportInput[], index: WikilinkIndex): WikilinkExportMap {
  const headings = inputs.map(
    (input) => extractASTNodes(markdownToAST(input.markdown), "Heading") as Heading[],
  );
  const links: Record<string, WikilinkDestination> = {};

  for (const input of inputs) {
    for (const link of extractASTNodes(
      markdownToAST(input.markdown),
      "ZettelkastenLink",
    ) as ZettelkastenLink[]) {
      const { target, fragment } = splitWikilinkTarget(link.target);
      const resolution = index.resolve(target, input.path);
      if (resolution.status !== "resolved") {
        continue;
      }
      const documentPath = resolution.path;
      const destinationInput = inputs.findIndex((candidate) => candidate.path === documentPath);
      if (destinationInput < 0) {
        continue;
      }
      const heading =
        fragment === undefined || fragment === ""
          ? 0
          : fragmentHeadingIndex(headings[destinationInput], fragment);
      if (heading < 0) {
        continue;
      }
      if (headings[destinationInput].length === 0) {
        throw new Error(
          `The link [[${link.target}]] in ${input.path} names ${documentPath}, which has no heading to link to`,
        );
      }
      const previous = links[link.target];
      if (
        previous !== undefined &&
        (previous.input !== destinationInput || previous.heading !== heading)
      ) {
        throw new Error(
          `The link [[${link.target}]] leads to different places in the files of this export`,
        );
      }
      links[link.target] = { input: destinationInput, heading };
    }
  }

  return { inputs: headings.map((list) => ({ headings: list.length })), links };
}
