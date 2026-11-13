/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Heading count of the wikilink export map
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     filters/wikilinks.lua of pandoc-config finds the heading
 *                  of a wikilink by its place among the Header elements that
 *                  Pandoc reads, and refuses the export when the count of
 *                  the editor differs from the count of Pandoc (#203). The
 *                  map therefore counts the headings that Pandoc reads. The
 *                  Pandoc 3.10.2 JSON reader, with the reader extensions of
 *                  an export, is the oracle.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { wikilinkExportMap } from "source/common/util/wikilink-export";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { execPandocReference } from "./pandoc-reference";

const EXPORT_READER = "markdown+tex_math_single_backslash+wikilinks_title_after_pipe";

interface PandocElement {
  t?: string;
  c?: unknown;
}

function countHeaders(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item: unknown) => sum + countHeaders(item), 0);
  }
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  const element = value as PandocElement;
  return (element.t === "Header" ? 1 : 0) + countHeaders(element.c);
}

function pandocHeadingCount(markdown: string): number {
  const raw = execPandocReference(["-f", EXPORT_READER, "-t", "json"], { input: markdown });
  return countHeaders((JSON.parse(raw) as { blocks: unknown }).blocks);
}

function editorHeadingCount(markdown: string): number {
  const inputs = [
    { path: "/notes/source.md", markdown: "See [[target]].\n" },
    { path: "/notes/target.md", markdown },
  ];
  const index = new WikilinkIndex(
    inputs.map((input) => ({
      path: input.path,
      root: "/notes",
      id: "",
      title: undefined,
      aliases: [],
    })),
  );
  const map = wikilinkExportMap(inputs, { index, linkFormat: "link|title" });
  return map.inputs[1].headings;
}

describe("wikilink export map heading count", function () {
  const cases: Array<[string, string]> = [
    ["a paragraph line before a heading", "# Start\n\nSome text\n# Not a heading\n"],
    ["a heading in a block quote", "# Start\n\n> # Quoted\n"],
    ["a heading in a list item", "# Start\n\n- # Listed\n"],
    ["a heading in a fenced div", "# Start\n\n::: theorem\n# Inside\n:::\n"],
    ["a heading in an HTML block", "# Start\n\n<div>\n\n# Inside HTML\n\n</div>\n"],
    ["a heading line in a code block", "# Start\n\n```\n# comment\n```\n"],
    ["a hash without a space", "# Start\n\n#tag line\n"],
    ["a heading in a footnote", "# Start[^1]\n\n[^1]: Note.\n\n    # Note heading\n"],
    ["a Setext heading under math", "# Start\n\n$x$\n===\n"],
  ];

  for (const [name, markdown] of cases) {
    it(`counts the headings that Pandoc reads in a document with ${name}`, function () {
      assert.equal(editorHeadingCount(markdown), pandocHeadingCount(markdown));
    });
  }
});
