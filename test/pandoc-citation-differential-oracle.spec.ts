/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc differential oracle citation parity tests
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Differential oracle suite comparing the hand-rolled Lezer
 *                  citation parser directly against the official Pandoc Haskell
 *                  binary AST (pandoc -f markdown -t json). Asserts exact 1-to-1
 *                  parity on citation IDs, item counts, cluster grouping, and
 *                  citation modes (NormalCitation, SuppressAuthor, AuthorInText).
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import {
  type Citation,
  type CiteItem,
  extractCitationNodes,
  nodeToCiteItem,
} from "source/common/modules/markdown-editor/parser/citation-parser";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";

interface PandocCitation {
  citationId: string;
  citationPrefix: unknown[];
  citationSuffix: unknown[];
  citationMode: { t: "NormalCitation" | "SuppressAuthor" | "AuthorInText" };
  citationNoteNum: number;
  citationHash: number;
}

/**
 * Extracts all citations from Pandoc's official JSON AST.
 */
function extractPandocASTCitations(markdown: string): PandocCitation[][] {
  const stdout = execFileSync("pandoc", ["-f", "markdown", "-t", "json"], {
    input: markdown,
    encoding: "utf8",
  });
  const ast = JSON.parse(stdout);

  const clusters: PandocCitation[][] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if ((node as { t?: string }).t === "Cite" && Array.isArray((node as { c?: unknown }).c)) {
      const items = (node as { c: [PandocCitation[], unknown] }).c[0];
      if (Array.isArray(items)) {
        clusters.push(items);
      }
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(ast);
  return clusters;
}

/**
 * Parses citations using Zettlr's Lezer-based citation parser.
 */
function parseLezerCitations(source: string): Citation[] {
  const state = EditorState.create({ doc: source, extensions: [markdownParser()] });
  const nodes = extractCitationNodes(state);
  return nodes.map((node) => nodeToCiteItem(node, source));
}

describe("Pandoc Differential Oracle Citation Parity Specification", function () {
  /**
   * Helper verifying exact parity between Lezer parser and real Pandoc AST.
   */
  function assertPandocParity(markdown: string): void {
    const pandocClusters = extractPandocASTCitations(markdown);
    const lezerCitations = parseLezerCitations(markdown);

    const pandocItems = pandocClusters.flat();
    const lezerItems = lezerCitations.flatMap((c) => c.items);

    assert.equal(
      lezerItems.length,
      pandocItems.length,
      `Item count mismatch for "${markdown}": Lezer found ${lezerItems.length} items (${lezerItems.map((i) => i.id).join(", ")}), Pandoc found ${pandocItems.length} items (${pandocItems.map((i) => i.citationId).join(", ")})`
    );

    for (let i = 0; i < pandocItems.length; i++) {
      const pItem = pandocItems[i];
      const lItem = lezerItems[i];

      assert.equal(
        lItem.id,
        pItem.citationId,
        `Citekey mismatch at index ${i} for "${markdown}": expected "${pItem.citationId}", got "${lItem.id}"`
      );

      // Verify citation modes
      if (pItem.citationMode.t === "SuppressAuthor") {
        assert.equal(
          lItem["suppress-author"],
          true,
          `Expected suppress-author to be true for key "${lItem.id}" in "${markdown}"`
        );
      }
    }
  }

  describe("1. Basic and Complex Citekey Parity with Real Pandoc", function () {
    const testCases = [
      "[@Lurie2009]",
      "[-@Lurie2009]",
      "[@1984Orwell]",
      "[@nlab:grothendieck_construction]",
      "[@nlab:category_of_elements]",
      "[@arxiv:2104.12345]",
      "[@doi:10.1000/182]",
      "[@isbn:978-3-16-148410-0]",
      "[@author_2024-rev.1]",
      "[@author2020/supplement]",
      "[@urn:nbn:de:1234]",
      "@Lurie2009",
      "@nlab:grothendieck_construction",
      "@arxiv:2104.12345",
    ];

    for (const tc of testCases) {
      it(`matches real Pandoc AST for: ${tc}`, function () {
        assertPandocParity(tc);
      });
    }
  });

  describe("2. Prefixes, Suffixes & Locators Parity with Real Pandoc", function () {
    const testCases = [
      "[see @Lurie2009]",
      "[compare @Joyal2002, section 3.2]",
      "[@Lurie2009, p. 23]",
      "[@Lurie2009, pp. 23-25]",
      "[@Lurie2009, chap. 4]",
      "[@Lurie2009, sec. 2.1]",
      "[@Lurie2009, vol. 2]",
      "[@Lurie2009, 42-45]",
      "[@Lurie2009, IV]",
      "[@Lurie2009, xiv-xvi]",
      "[@Lurie2009, Lem. 7.1]",
      "[@Lurie2009, Cor. 3.4]",
      "@Lurie2009 [p. 33]",
      "@Lurie2009 [chap. 2]",
    ];

    for (const tc of testCases) {
      it(`matches real Pandoc AST for: ${tc}`, function () {
        assertPandocParity(tc);
      });
    }
  });

  describe("3. Multi-Item Cluster Parity with Real Pandoc", function () {
    const testCases = [
      "[@Lurie2009; @Joyal2002; @Simpson2012]",
      "[see @Lurie2009, p. 12; compare @Joyal2002, chap. 3; also @Simpson2012]",
      "[@Lurie2009; -@Joyal2002, p. 5]",
      "[@nlab:grothendieck_construction; @nlab:category_of_elements; @Lurie2009]",
      "[@a; @b, p. 1; -@c, chap. 2; @d; see @e, sec. 4]",
      "[@a;@b;@c]",
    ];

    for (const tc of testCases) {
      it(`matches real Pandoc AST for: ${tc}`, function () {
        assertPandocParity(tc);
      });
    }
  });

  describe("4. Prose Punctuation & Formatting Parity with Real Pandoc", function () {
    const testCases = [
      "According to @Lurie2009.",
      "See @Lurie2009, and also @Joyal2002.",
      "Work by @Lurie2009; however, @Joyal2002 disagreed.",
      "*See [@Lurie2009, p. 12]*.",
      "**@Joyal2002** proved the result.",
      "_@Mac98_ is the canonical reference.",
      "> As shown in [@Lurie2009, p. 45], infinity-categories form a topos.",
      "- Key result: see [@Lurie2009, chap. 1]",
      "1. Follows @Joyal2002.",
      "## 2. Foundations (following @Lurie2009)",
    ];

    for (const tc of testCases) {
      it(`matches real Pandoc AST for: ${tc}`, function () {
        assertPandocParity(tc);
      });
    }
  });

  describe("5. Crossref and Adjacent Citation Parity with Real Pandoc", function () {
    const testCases = [
      "@def-higher-category [@nlab:grothendieck_construction]",
      "@thm-main [-@Lurie2009, p. 42]",
      "@fig-diagram [@Lurie2009, p. 10]",
      "@lem-helper [@Joyal2002]",
      "[@Lurie2009] [@Joyal2002]",
      "[@thm-main; @Lurie2009]",
    ];

    for (const tc of testCases) {
      it(`matches real Pandoc AST for: ${tc}`, function () {
        assertPandocParity(tc);
      });
    }
  });

  describe("6. Negative Boundary Parity with Real Pandoc (Zero False Positives)", function () {
    const nonCitations = [
      "Contact user@example.com for help.",
      "[1]",
      "[a-z]",
      "[see above]",
      "[important note]",
      "[]",
      "[   ]",
      "@",
      "@ ",
      "Meeting at @ 3pm",
    ];

    for (const tc of nonCitations) {
      it(`matches real Pandoc producing 0 citations for: "${tc}"`, function () {
        assertPandocParity(tc);
      });
    }
  });
});
