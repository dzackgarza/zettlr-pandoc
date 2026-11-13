/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Heading identifier spec
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The identifier of a heading in the editor is the
 *                  identifier that Pandoc gives it (#203). The table of
 *                  contents, the heading completion after `](#` and a click
 *                  on an `#id` link read it; an export links `#id` to the
 *                  heading that Pandoc's `auto_identifiers` names. The
 *                  executable Pandoc JSON reader is the oracle.
 *
 * END HEADER
 */

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { strict as assert } from "assert";
import { tocField } from "source/common/modules/markdown-editor/plugins/toc-field";
import { execPandocReference } from "./pandoc-reference";

const PANDOC_READER = "markdown+raw_tex+tex_math_dollars+tex_math_single_backslash";

interface PandocBlock {
  t: string;
  c?: unknown;
}

function pandocHeaderIdentifiers(source: string): string[] {
  const raw = execPandocReference(["-f", PANDOC_READER, "-t", "json"], { input: source });
  const document = JSON.parse(raw) as { blocks: PandocBlock[] };
  return document.blocks
    .filter((block) => block.t === "Header")
    .map((block) => {
      const [, [identifier]] = block.c as [number, [string, string[], string[][]], unknown];
      return identifier;
    });
}

function editorHeaderIdentifiers(source: string): string[] {
  const state = EditorState.create({ doc: source, extensions: [markdownParser(), tocField] });
  assert.notEqual(ensureSyntaxTree(state, state.doc.length, 5000), null);
  return state.field(tocField).map((entry) => entry.id);
}

describe("heading identifiers", function () {
  const cases: Array<[string, string]> = [
    ["math", "# Genus of $p^2$ forms\n"],
    ["inline code", "# The `rank` function\n"],
    ["non-ASCII letters and emphasis", "# Théorème de *Torelli*\n"],
    ["a leading digit", "# 2 Lattices of rank two\n"],
    ["a link", "# See [the paper](https://example.org/genus) here\n"],
    ["a footnote", "# Heading with a note[^1]\n\n[^1]: The note.\n"],
    ["an inline footnote", "# Heading with a note^[An inline note.] here\n"],
    ["Greek letters and underscores", "# Ünïcode ΓΔ lattice of snake_case\n"],
    ["a span, a superscript and quotes", '# A [span]{.smallcaps} x^2^ and "quoted"\n'],
    ["backslash math", "# The \\(K3\\) surface\n"],
    ["a citation", "# Results of [@CS10]\n"],
    ["punctuation only", "# ???\n"],
    ["a Setext heading", "Setext *heading*\n================\n"],
    ["an escape and an entity", "# Lattices \\& forms &amp; more\n"],
    ["a raw HTML anchor", '# A <a name="anchor">named</a> heading\n'],
    ["dashes and an ellipsis", "# Wait... rank 1--2 --- signature\n"],
    [
      "raw TeX, raw code and code attributes",
      "# A \\ref{x} `y`{=latex} `z`{.haskell} &eacute;t&eacute;\n",
    ],
    [
      "a reference link and a link title",
      '# A [ref][x] and [t](u "Title") b\n\n[x]: https://example.org\n',
    ],
  ];

  for (const [name, source] of cases) {
    it(`gives a heading with ${name} the identifier that Pandoc gives it`, function () {
      assert.deepEqual(editorHeaderIdentifiers(source), pandocHeaderIdentifiers(source));
    });
  }

  it("numbers a repeated heading as Pandoc does, after an explicit identifier", function () {
    const source = [
      "# Introduction {#intro}",
      "",
      "# Intro",
      "",
      "# Lemma",
      "",
      "# Lemma",
      "",
      "# Lemma",
      "",
    ].join("\n");
    assert.deepEqual(editorHeaderIdentifiers(source), pandocHeaderIdentifiers(source));
  });
});
