/**
 * The keys of the front matter field `nocite`: the items that Pandoc puts
 * into the bibliography of a document that does not cite them
 * (https://pandoc.org/MANUAL.html#including-uncited-items-in-the-bibliography).
 *
 * Pandoc reads a string of the metadata as Markdown, and the citations of
 * that text are the uncited items: `@a`, `@a @b`, `@a, @b` and `[@a; @b]`
 * name the same keys as in the text of the document. A list holds such
 * strings. The citation `@*` puts each item of the bibliography in it.
 */

import { extractASTNodes, markdownToAST } from "@common/modules/markdown-utils";
import type { CitationNode } from "@common/modules/markdown-utils/markdown-ast";
import type { YamlValue } from "@dts/common/fsal";

export interface UncitedItems {
  /** The keys of the citations of the field, in their order. */
  keys: string[];
  /** The field holds `@*`: each item of the bibliography. */
  all: boolean;
}

/**
 * `@*` is the citation of the key `*` in Pandoc's grammar. The citation
 * parser of the editor reads only keys that start with a letter, a digit or
 * `_`, so this reads `@*` at a position where a citation can start.
 */
const EACH_ITEM = /(^|[\s,;[])@\*(?=$|[\s,;\]])/;

function strings(value: YamlValue): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  return [];
}

export function uncitedItems(nocite: YamlValue | undefined): UncitedItems {
  const texts = nocite === undefined ? [] : strings(nocite);
  const keys = texts.flatMap((text) =>
    (extractASTNodes(markdownToAST(text), "Citation") as CitationNode[]).flatMap((node) =>
      node.parsedCitation.items.map((item) => item.id),
    ),
  );
  return { keys, all: texts.some((text) => EACH_ITEM.test(text)) };
}
