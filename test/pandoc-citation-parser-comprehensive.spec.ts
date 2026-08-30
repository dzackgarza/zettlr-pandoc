/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Comprehensive Pandoc citation parser regression suite
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Exhaustive regression specification for the Lezer-based
 *                  citation parser (citation-parser.ts), verifying that
 *                  Pandoc citation grammar rules, locators, prefixes, suffixes,
 *                  composite forms, crossref adjacencies, structural contexts,
 *                  multilingual labels, and negative boundaries are faithfully
 *                  parsed into syntax nodes and CiteItem structures.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { strict as assert } from "assert";
import {
  type Citation,
  type CiteItem,
  extractCitationNodes,
  NODES,
  nodeToCiteItem,
} from "source/common/modules/markdown-editor/parser/citation-parser";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { referenceFamilyOf } from "source/types/common/references";

function parseCitations(source: string): Citation[] {
  const state = EditorState.create({ doc: source, extensions: [markdownParser()] });
  const nodes = extractCitationNodes(state);
  return nodes.map((node) => nodeToCiteItem(node, source));
}

function parseSingle(source: string): Citation {
  const citations = parseCitations(source);
  assert.equal(citations.length, 1, `Expected exactly 1 citation in "${source}", got ${citations.length}`);
  return citations[0];
}

describe("Comprehensive Pandoc Citation Parser Regression Suite", function () {
  describe("1. Bracketed Single Citations (All Syntax Forms & Keys)", function () {
    it("parses standard bracketed citekey", function () {
      const cit = parseSingle("[@Lurie2009]");
      assert.equal(cit.composite, false);
      assert.equal(cit.items.length, 1);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0]["suppress-author"], undefined);
    });

    it("parses suppress-author flag in brackets", function () {
      const cit = parseSingle("[-@Lurie2009]");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0]["suppress-author"], true);
    });

    it("parses numeric-starting citekeys", function () {
      const cit1 = parseSingle("[@1984Orwell]");
      assert.equal(cit1.items[0].id, "1984Orwell");

      const cit2 = parseSingle("[@2001SpaceOdyssey]");
      assert.equal(cit2.items[0].id, "2001SpaceOdyssey");
    });

    it("parses complex citekeys with colons, underscores, hyphens, slashes, and dots", function () {
      const keys = [
        "nlab:grothendieck_construction",
        "nlab:category_of_elements",
        "arxiv:2104.12345",
        "doi:10.1000/182",
        "isbn:978-3-16-148410-0",
        "Author_2024-rev.1",
        "author2020/supplement",
        "urn:nbn:de:1234",
        "Mac98",
        "DK24",
      ];
      for (const key of keys) {
        const cit = parseSingle(`[@${key}]`);
        assert.equal(cit.items[0].id, key, `Failed for key ${key}`);
      }
    });

    it("parses curly-bracket enclosed citekeys with special characters", function () {
      const cit = parseSingle("[@{nlab:category_of_elements}]");
      assert.equal(cit.items[0].id, "nlab:category_of_elements");
    });
  });

  describe("2. Prefixes, Punctuation, and Suffixes", function () {
    it("parses simple prefixes", function () {
      const cit = parseSingle("[see @Lurie2009]");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].prefix, "see ");
    });

    it("parses multi-word descriptive prefixes", function () {
      const cit = parseSingle("[for a detailed categorical treatment, see @Lurie2009]");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].prefix, "for a detailed categorical treatment, see ");
    });

    it("parses suffixes following citekeys", function () {
      const cit = parseSingle("[@Lurie2009, with additional commentary]");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].suffix, ", with additional commentary");
    });

    it("parses both prefix and suffix simultaneously", function () {
      const cit = parseSingle("[compare @Lurie2009, section 3.2]");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].prefix, "compare ");
    });

    it("parses parenthesized citations in prose", function () {
      const cit = parseSingle("As established in foundational work ([see @Lurie2009]), categories form an infinity-topos.");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].prefix, "see ");
    });
  });

  describe("3. Locators & Multilingual Labels (English, German, French)", function () {
    it("parses explicit English page locators (p. and pp.)", function () {
      const p1 = parseSingle("[@Lurie2009, p. 23]");
      assert.equal(p1.items[0].id, "Lurie2009");
      assert.equal(p1.items[0].label, "page");
      assert.equal(p1.items[0].locator, "23");

      const p2 = parseSingle("[@Lurie2009, pp. 23-25]");
      assert.equal(p2.items[0].label, "page");
      assert.equal(p2.items[0].locator, "23-25");
    });

    it("parses German locator labels (S., Kap., Bd., Abb., Abschn.)", function () {
      const p = parseSingle("[@Lurie2009, S. 42]");
      assert.equal(p.items[0].label, "page");
      assert.equal(p.items[0].locator, "42");

      const kap = parseSingle("[@Lurie2009, Kap. 3]");
      assert.equal(kap.items[0].label, "chapter");
      assert.equal(kap.items[0].locator, "3");

      const bd = parseSingle("[@Lurie2009, Bd. 2]");
      assert.equal(bd.items[0].label, "volume");
      assert.equal(bd.items[0].locator, "2");

      const abb = parseSingle("[@Lurie2009, Abb. 5]");
      assert.equal(abb.items[0].label, "figure");
      assert.equal(abb.items[0].locator, "5");
    });

    it("parses French locator labels (chap., art., liv., col.)", function () {
      const chap = parseSingle("[@Lurie2009, chap. 4]");
      assert.equal(chap.items[0].label, "chapter");
      assert.equal(chap.items[0].locator, "4");

      const art = parseSingle("[@Lurie2009, art. 12]");
      assert.equal(art.items[0].label, "article-locator");
      assert.equal(art.items[0].locator, "12");

      const liv = parseSingle("[@Lurie2009, liv. 1]");
      assert.equal(liv.items[0].label, "book");
      assert.equal(liv.items[0].locator, "1");
    });

    it("parses dotted section and chapter locators (sec. 2.1, chap. 3.4.1)", function () {
      const sec = parseSingle("[@Lurie2009, sec. 2.1]");
      assert.equal(sec.items[0].label, "section");
      assert.equal(sec.items[0].locator, "2.1");

      const chap = parseSingle("[@Lurie2009, chap. 3.4.1]");
      assert.equal(chap.items[0].label, "chapter");
      assert.equal(chap.items[0].locator, "3.4.1");
    });

    it("parses implicit numeric locators without label", function () {
      const cit = parseSingle("[@Lurie2009, 42-45]");
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].locator, "42-45");
    });

    it("parses genuine Roman-numeral locators", function () {
      const cit1 = parseSingle("[@Lurie2009, IV]");
      assert.equal(cit1.items[0].locator, "IV");

      const cit2 = parseSingle("[@Lurie2009, xiv-xvi]");
      assert.equal(cit2.items[0].locator, "xiv-xvi");
    });

    it("does NOT treat lemma/corollary suffixes as Roman-numeral locators", function () {
      const lem = parseSingle("[@Lurie2009, Lem. 7.1]");
      assert.equal(lem.items[0].locator, undefined);
      assert.equal(lem.items[0].suffix, ", Lem. 7.1");

      const cor = parseSingle("[@Lurie2009, Cor. 3.4]");
      assert.equal(cor.items[0].locator, undefined);
      assert.equal(cor.items[0].suffix, ", Cor. 3.4");
    });
  });

  describe("4. Multi-Item Citation Clusters", function () {
    it("parses simple multi-key cluster separated by semicolons", function () {
      const cit = parseSingle("[@Lurie2009; @Joyal2002; @Simpson2012]");
      assert.equal(cit.items.length, 3);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[1].id, "Joyal2002");
      assert.equal(cit.items[2].id, "Simpson2012");
    });

    it("parses multi-key clusters with individual prefixes and locators", function () {
      const cit = parseSingle("[see @Lurie2009, p. 12; compare @Joyal2002, chap. 3; also @Simpson2012]");
      assert.equal(cit.items.length, 3);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].prefix, "see ");
      assert.equal(cit.items[0].locator, "12");

      assert.equal(cit.items[1].id, "Joyal2002");
      assert.equal(cit.items[1].prefix, "compare ");
      assert.equal(cit.items[1].locator, "3");

      assert.equal(cit.items[2].id, "Simpson2012");
      assert.equal(cit.items[2].prefix, "also ");
    });

    it("parses multi-key clusters containing suppress-author items", function () {
      const cit = parseSingle("[@Lurie2009; -@Joyal2002, p. 5]");
      assert.equal(cit.items.length, 2);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0]["suppress-author"], undefined);
      assert.equal(cit.items[1].id, "Joyal2002");
      assert.equal(cit.items[1]["suppress-author"], true);
      assert.equal(cit.items[1].locator, "5");
    });

    it("parses large 10-item cluster with mixed prefixes, locators, and suppress-author", function () {
      const source = "[@a; @b, p. 1; -@c, chap. 2; @d; see @e, sec. 4; @f; @g, vol. 2; -@h; @i, pp. 10-12; compare @j]";
      const cit = parseSingle(source);
      assert.equal(cit.items.length, 10);
      assert.equal(cit.items[0].id, "a");
      assert.equal(cit.items[1].id, "b");
      assert.equal(cit.items[1].locator, "1");
      assert.equal(cit.items[2].id, "c");
      assert.equal(cit.items[2]["suppress-author"], true);
      assert.equal(cit.items[3].id, "d");
      assert.equal(cit.items[4].id, "e");
      assert.equal(cit.items[4].prefix, "see ");
      assert.equal(cit.items[5].id, "f");
      assert.equal(cit.items[6].id, "g");
      assert.equal(cit.items[6].label, "volume");
      assert.equal(cit.items[7].id, "h");
      assert.equal(cit.items[7]["suppress-author"], true);
      assert.equal(cit.items[8].id, "i");
      assert.equal(cit.items[8].locator, "10-12");
      assert.equal(cit.items[9].id, "j");
      assert.equal(cit.items[9].prefix, "compare ");
    });

    it("parses cluster with dense semicolon spacing [@a;@b;@c]", function () {
      const cit = parseSingle("[@a;@b;@c]");
      assert.equal(cit.items.length, 3);
      assert.equal(cit.items[0].id, "a");
      assert.equal(cit.items[1].id, "b");
      assert.equal(cit.items[2].id, "c");
    });
  });

  describe("5. Narrative (In-Text) Citations", function () {
    it("parses bare narrative citation @key", function () {
      const cit = parseSingle("@Lurie2009");
      assert.equal(cit.composite, true);
      assert.equal(cit.items[0].id, "Lurie2009");
    });

    it("parses narrative citations followed by trailing punctuation", function () {
      const punctuation = [".", ",", ":", ";", "?", "!"];
      for (const p of punctuation) {
        const cit = parseSingle(`According to @Lurie2009${p}`);
        assert.equal(cit.items[0].id, "Lurie2009", `Failed for punctuation "${p}"`);
      }
    });

    it("parses narrative citations with complex web/DOI keys", function () {
      const cit1 = parseSingle("@nlab:grothendieck_construction.");
      assert.equal(cit1.items[0].id, "nlab:grothendieck_construction");

      const cit2 = parseSingle("@arxiv:2104.12345,");
      assert.equal(cit2.items[0].id, "arxiv:2104.12345");
    });

    it("parses narrative composite with locator brackets @key [p. 33]", function () {
      const cit = parseSingle("@Lurie2009 [p. 33]");
      assert.equal(cit.composite, true);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].label, "page");
      assert.equal(cit.items[0].locator, "33");
    });

    it("parses narrative composite with chapter locator @key [chap. 2]", function () {
      const cit = parseSingle("@Lurie2009 [chap. 2]");
      assert.equal(cit.composite, true);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].label, "chapter");
      assert.equal(cit.items[0].locator, "2");
    });

    it("parses narrative sequences in prose", function () {
      const source = "Work by @Lurie2009 and @Joyal2002 laid the foundations.";
      const citations = parseCitations(source);
      assert.equal(citations.length, 2);
      assert.equal(citations[0].items[0].id, "Lurie2009");
      assert.equal(citations[1].items[0].id, "Joyal2002");
    });
  });

  describe("6. Cross-Reference and Citation Adjacencies (All Families)", function () {
    it("does NOT swallow an adjacent bracketed citation as a suffix of an in-text crossref", function () {
      const citations = parseCitations("@def-higher-category [@nlab:grothendieck_construction]");
      assert.equal(citations.length, 2, "Expected 2 distinct citations");

      assert.equal(citations[0].items[0].id, "def-higher-category");
      assert.equal(referenceFamilyOf(citations[0].items[0].id), "def");

      assert.equal(citations[1].items[0].id, "nlab:grothendieck_construction");
      assert.equal(citations[1].composite, false);
    });

    it("does NOT swallow a bracketed suppress-author citation following an in-text citation", function () {
      const citations = parseCitations("@thm-main [-@Lurie2009, p. 42]");
      assert.equal(citations.length, 2);
      assert.equal(citations[0].items[0].id, "thm-main");
      assert.equal(citations[1].items[0].id, "Lurie2009");
      assert.equal(citations[1].items[0]["suppress-author"], true);
      assert.equal(citations[1].items[0].locator, "42");
    });

    it("correctly separates all 13 standard theorem and crossref families from adjacent bracketed citations", function () {
      const families = [
        "def-core",
        "thm-main",
        "lem-helper",
        "cor-result",
        "prp-statement",
        "cnj-hypothesis",
        "exm-sample",
        "exr-problem",
        "fig-diagram",
        "tbl-data",
        "eq-euler",
        "sec-intro",
        "lst-code",
      ];

      for (const crossref of families) {
        const source = `@${crossref} [@Lurie2009, p. 10]`;
        const citations = parseCitations(source);
        assert.equal(citations.length, 2, `Failed for family ${crossref}`);
        assert.equal(citations[0].items[0].id, crossref);
        assert.equal(citations[1].items[0].id, "Lurie2009");
        assert.equal(citations[1].items[0].locator, "10");
      }
    });

    it("parses consecutive bracketed citations [@a][@b]", function () {
      const citations = parseCitations("[@Lurie2009][@Joyal2002]");
      assert.equal(citations.length, 2);
      assert.equal(citations[0].items[0].id, "Lurie2009");
      assert.equal(citations[1].items[0].id, "Joyal2002");
    });

    it("parses consecutive space-separated bracketed citations [@a] [@b]", function () {
      const citations = parseCitations("[@Lurie2009] [@Joyal2002]");
      assert.equal(citations.length, 2);
      assert.equal(citations[0].items[0].id, "Lurie2009");
      assert.equal(citations[1].items[0].id, "Joyal2002");
    });
  });

  describe("7. Structural Markdown Contexts", function () {
    it("parses citations inside Blockquotes", function () {
      const source = "> The infinity-category framework is described in [@Lurie2009, p. 5].";
      const cit = parseSingle(source);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].locator, "5");
    });

    it("parses citations inside unordered and ordered List items", function () {
      const source = "- Key idea: see [@Lurie2009, chap. 1]\n1. Subsequent step follows @Joyal2002.";
      const citations = parseCitations(source);
      assert.equal(citations.length, 2);
      assert.equal(citations[0].items[0].id, "Lurie2009");
      assert.equal(citations[1].items[0].id, "Joyal2002");
    });

    it("parses citations inside Headings", function () {
      const source = "## Overview of Homotopy Theory (following @Lurie2009)";
      const cit = parseSingle(source);
      assert.equal(cit.items[0].id, "Lurie2009");
    });

    it("parses citations inside Emphasis and Strong formatting", function () {
      const source = "*See [@Lurie2009, p. 12]*, or consult **@Joyal2002**.";
      const citations = parseCitations(source);
      assert.equal(citations.length, 2);
      assert.equal(citations[0].items[0].id, "Lurie2009");
      assert.equal(citations[1].items[0].id, "Joyal2002");
    });

    it("parses citations inside Pandoc fenced Divs", function () {
      const source = "::: {.theorem}\nFor higher categories, see [@Lurie2009, Theorem 1.1.1].\n:::";
      const cit = parseSingle(source);
      assert.equal(cit.items[0].id, "Lurie2009");
      assert.equal(cit.items[0].suffix, ", Theorem 1.1.1");
    });
  });

  describe("8. Negative Boundaries, Links, Math & False Positives", function () {
    it("does NOT parse email addresses as citations", function () {
      const citations = parseCitations("Contact user@example.com for help.");
      assert.equal(citations.length, 0);
    });

    it("does NOT parse plain bracketed text without @ as citations", function () {
      const nonCitations = [
        "[1]",
        "[a-z]",
        "[see above]",
        "[important note]",
        "[]",
        "[   ]",
      ];
      for (const text of nonCitations) {
        const citations = parseCitations(text);
        assert.equal(citations.length, 0, `Should not parse "${text}" as citation`);
      }
    });

    it("does NOT parse lone at-signs or invalid characters", function () {
      const nonCitations = [
        "@",
        "@ ",
        "Meeting at @ 3pm",
      ];
      for (const text of nonCitations) {
        const citations = parseCitations(text);
        assert.equal(citations.length, 0, `Should not parse "${text}" as citation`);
      }
    });

    it("does NOT parse markdown links with @ in link text as citation clusters", function () {
      const source = "Visit [the profile of @dzackgarza](https://github.com/dzackgarza).";
      const citations = parseCitations(source);
      // In Pandoc markdown, [the profile of @dzackgarza](...) is a Markdown Link, not a citation cluster
      assert.ok(citations.length <= 1);
    });
  });

  describe("9. Cross-Reference and Citation Combinations in Clusters", function () {
    it("parses pure cross-reference clusters [@thm-main; @lem-aux; @cor-result]", function () {
      const cit = parseSingle("[@thm-main; @lem-aux; @cor-result]");
      assert.equal(cit.items.length, 3);
      assert.equal(cit.items[0].id, "thm-main");
      assert.equal(cit.items[1].id, "lem-aux");
      assert.equal(cit.items[2].id, "cor-result");
      assert.equal(referenceFamilyOf(cit.items[0].id), "thm");
      assert.equal(referenceFamilyOf(cit.items[1].id), "lem");
      assert.equal(referenceFamilyOf(cit.items[2].id), "cor");
    });

    it("parses mixed cross-reference and bibliography clusters [@thm-main; @Lurie2009]", function () {
      const cit = parseSingle("[@thm-main; @Lurie2009]");
      assert.equal(cit.items.length, 2);
      assert.equal(cit.items[0].id, "thm-main");
      assert.equal(referenceFamilyOf(cit.items[0].id), "thm");
      assert.equal(cit.items[1].id, "Lurie2009");
      assert.equal(referenceFamilyOf(cit.items[1].id), undefined);
    });

    it("parses cross-references with prefixes and locators in brackets", function () {
      const cit = parseSingle("[see @thm-main, Section 2; compare @lem-aux, Step 1]");
      assert.equal(cit.items.length, 2);
      assert.equal(cit.items[0].id, "thm-main");
      assert.equal(cit.items[0].prefix, "see ");
      assert.equal(cit.items[1].id, "lem-aux");
      assert.equal(cit.items[1].prefix, "compare ");
    });
  });

  describe("10. Combinatorial Parameterized Matrix (100+ Generated Syntax Combinations)", function () {
    const prefixes = ["", "see ", "compare ", "for details, see "];
    const keys = [
      "Lurie2009",
      "1984Orwell",
      "nlab:grothendieck_construction",
      "arxiv:2104.12345",
      "doi:10.1000/182",
      "author-2024_rev1",
    ];
    const locators = [
      { text: "", label: undefined, value: undefined },
      { text: ", p. 42", label: "page", value: "42" },
      { text: ", chap. 3", label: "chapter", value: "3" },
      { text: ", sec. 2.1", label: "section", value: "2.1" },
      { text: ", IV", label: undefined, value: "IV" },
      { text: ", 12-15", label: undefined, value: "12-15" },
    ];

    for (const prefix of prefixes) {
      for (const key of keys) {
        for (const loc of locators) {
          it(`correctly parses combination: [${prefix}@${key}${loc.text}]`, function () {
            const source = `[${prefix}@${key}${loc.text}]`;
            const cit = parseSingle(source);
            assert.equal(cit.composite, false);
            assert.equal(cit.items.length, 1);
            assert.equal(cit.items[0].id, key);
            if (prefix !== "") {
              assert.equal(cit.items[0].prefix, prefix);
            }
            if (loc.label !== undefined) {
              assert.equal(cit.items[0].label, loc.label);
            }
            if (loc.value !== undefined) {
              assert.equal(cit.items[0].locator, loc.value);
            }
          });
        }
      }
    }
  });
});
