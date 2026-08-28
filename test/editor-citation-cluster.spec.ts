/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Multi-key citation cluster rendering
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Proves that a Pandoc citation cluster holding several
 *                  citekeys reaches citeproc as the cluster Pandoc describes:
 *                  every key is present, the semicolon separators carry no
 *                  syntactic weight of their own, and the separator whitespace
 *                  never becomes citation content.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { strict as assert } from "assert";
import CSL from "citeproc";
import { readFileSync } from "fs";
import path from "path";
import {
  type CiteItem,
  extractCitationNodes,
  nodeToCiteItem,
} from "source/common/modules/markdown-editor/parser/citation-parser";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";

const STYLE = readFileSync(
  path.join(process.cwd(), "static/csl-styles/chicago-author-date.csl"),
  "utf8",
);
const LOCALE = readFileSync(
  path.join(process.cwd(), "static/csl-locales/locales-en-US.xml"),
  "utf8",
);

const LIBRARY: Record<string, CSLItem> = {
  DM20: {
    id: "DM20",
    type: "article-journal",
    title: "On automorphisms of enriques surfaces",
    author: [
      { family: "Dolgachev", given: "Igor" },
      { family: "Markushevich", given: "Dimitri" },
    ],
    issued: { "date-parts": [[2020]] },
  },
  DZ99: {
    id: "DZ99",
    type: "article-journal",
    title: "Modular forms and lattices",
    author: [{ family: "Zagier", given: "Don" }],
    issued: { "date-parts": [[1999]] },
  },
  DK13: {
    id: "DK13",
    type: "article-journal",
    title: "K3 surfaces of high picard rank",
    author: [{ family: "Kondo", given: "Shigeyuki" }],
    issued: { "date-parts": [[2013]] },
  },
};

/**
 * Renders the citation items through the real citeproc engine and the CSL
 * style Zettlr ships, which is the boundary the editor's citation widget uses.
 *
 * @param   {CiteItem[]}  items  The items produced by the citation parser.
 *
 * @return  {string}             The rendered citation cluster.
 */
function renderCluster(items: CiteItem[]): string {
  const engine = new CSL.Engine(
    {
      retrieveItem: (id: string) => LIBRARY[id],
      retrieveLocale: () => LOCALE,
    },
    STYLE,
    "en-US",
    true,
  );
  engine.updateItems(items.map((item) => item.id));
  return engine.makeCitationCluster(items);
}

/**
 * Parses the single citation contained in the Markdown source.
 *
 * @param   {string}      source  The Markdown source.
 *
 * @return  {CiteItem[]}          The cite items of that citation.
 */
function parseCluster(source: string): CiteItem[] {
  const state = EditorState.create({ doc: source, extensions: [markdownParser()] });
  const nodes = extractCitationNodes(state);
  assert.equal(nodes.length, 1, "the source must contain exactly one citation");
  return nodeToCiteItem(nodes[0], source).items;
}

describe("Editor parses multi-key citation clusters", function () {
  it("renders every key of a spaced cluster with one separator each", function () {
    const items = parseCluster("This follows from [@DM20; @DZ99; @DK13].");

    assert.deepEqual(
      items.map((item) => item.id),
      ["DM20", "DZ99", "DK13"],
    );
    assert.equal(
      renderCluster(items),
      "(Dolgachev and Markushevich 2020; Zagier 1999; Kondo 2013)",
    );
  });

  it("renders a cluster whose semicolons have no following space", function () {
    const items = parseCluster("This follows from [@DM20;@DZ99;@DK13].");

    assert.deepEqual(
      items.map((item) => item.id),
      ["DM20", "DZ99", "DK13"],
    );
    assert.equal(
      renderCluster(items),
      "(Dolgachev and Markushevich 2020; Zagier 1999; Kondo 2013)",
    );
  });

  it("keeps a real prefix while dropping the separator whitespace", function () {
    const items = parseCluster("This follows from [see @DM20; cf. @DZ99].");

    assert.deepEqual(
      items.map((item) => item.prefix),
      ["see ", "cf. "],
    );
    assert.equal(renderCluster(items), "(see Dolgachev and Markushevich 2020; cf. Zagier 1999)");
  });
});
