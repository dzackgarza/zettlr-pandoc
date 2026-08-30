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
 *                  composite forms, crossref adjacencies, and negative boundaries
 *                  are faithfully parsed into syntax nodes and CiteItem structures.
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
  describe("1. Bracketed Single Citations", function () {
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

    it("parses complex citekeys with colons, underscores, hyphens, and dots", function () {
      const keys = [
        "nlab:grothendieck_construction",
        "arxiv:2104.12345",
        "doi:10.1000/182",
        "isbn:978-3-16-148410-0",
        "Author_2024-rev.1",
        "author2020/supplement",
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

  describe("2. Prefixes and Suffixes in Bracketed Citations", function () {
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
  });

  describe("3. Locators (Explicit, Implicit, and Roman)", function () {
    it("parses explicit page locators (p. and pp.)", function () {
      const p1 = parseSingle("[@Lurie2009, p. 23]");
      assert.equal(p1.items[0].id, "Lurie2009");
      assert.equal(p1.items[0].label, "page");
      assert.equal(p1.items[0].locator, "23");

      const p2 = parseSingle("[@Lurie2009, pp. 23-25]");
      assert.equal(p2.items[0].label, "page");
      assert.equal(p2.items[0].locator, "23-25");
    });

    it("parses chapter, section, volume, and equation locators", function () {
      const chap = parseSingle("[@Lurie2009, chap. 4]");
      assert.equal(chap.items[0].label, "chapter");
      assert.equal(chap.items[0].locator, "4");

      const sec = parseSingle("[@Lurie2009, sec. 2.1]");
      assert.equal(sec.items[0].label, "section");
      assert.equal(sec.items[0].locator, "2.1");

      const vol = parseSingle("[@Lurie2009, vol. 2]");
      assert.equal(vol.items[0].label, "volume");
      assert.equal(vol.items[0].locator, "2");

      const eq = parseSingle("[@Lurie2009, eq. 12]");
      assert.equal(eq.items[0].label, "equation");
      assert.equal(eq.items[0].locator, "12");
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

    it("parses multi-key clusters with complex web/nLab keys", function () {
      const cit = parseSingle("[@nlab:grothendieck_construction; @nlab:category_of_elements; @Lurie2009]");
      assert.equal(cit.items.length, 3);
      assert.equal(cit.items[0].id, "nlab:grothendieck_construction");
      assert.equal(cit.items[1].id, "nlab:category_of_elements");
      assert.equal(cit.items[2].id, "Lurie2009");
    });
  });

  describe("5. In-Text (Narrative) Citations", function () {
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

    it("parses narrative citations with complex keys", function () {
      const cit = parseSingle("@nlab:grothendieck_construction.");
      assert.equal(cit.items[0].id, "nlab:grothendieck_construction");
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
  });

  describe("6. Cross-Reference and Citation Adjacencies", function () {
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

  describe("7. Negative Boundaries & Non-Citation Content", function () {
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
  });
});
