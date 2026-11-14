/* eslint-disable no-undef */
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        replaceTags tester
 * CVM-Role:        TESTING
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests a component of Zettlr.
 *
 * END HEADER
 */

// The harness must load before file-parser.ts, which imports 'electron'
// through the app service container at module scope.
import "./headless-electron-harness.cjs";
import replaceTags from "@common/util/replace-tags";
import { deepStrictEqual, strictEqual } from "assert";
import getMarkdownFileParser from "source/app/service-providers/fsal/util/file-parser";
import type { MDFileDescriptor } from "source/types/common/fsal";

const testDocument = `\
---
title: "A simple test document"
author: Zettlr
keywords:
- one tag
- second-tag
- Mixed-case-Tag
---

# A simple test document

This #document contains some tags as well as some edge-cases to test the ability
of the replaceTags function to properly replace tags within files.

It contains a YAML frontmatter that defines one keyword with a space in it that
cannot occur anywhere else in the document; as well as the #second-tag that now
also occurs within here. And a #MiXeD-case-TaG.

For example, if we have a [link](#second-tag), it shouldn't be replaced.
Similarly with [link](example.com#second-tag).`;

const replaceTagsTesters = [
  {
    // With spaces -> with spaces
    oldTag: "one tag",
    newTag: "A new keyword",
    expected: `\
---
title: "A simple test document"
author: Zettlr
keywords:
- A new keyword
- second-tag
- Mixed-case-Tag
---

# A simple test document

This #document contains some tags as well as some edge-cases to test the ability
of the replaceTags function to properly replace tags within files.

It contains a YAML frontmatter that defines one keyword with a space in it that
cannot occur anywhere else in the document; as well as the #second-tag that now
also occurs within here. And a #MiXeD-case-TaG.

For example, if we have a [link](#second-tag), it shouldn't be replaced.
Similarly with [link](example.com#second-tag).`,
  },
  {
    // No spaces -> no spaces
    oldTag: "second-tag",
    newTag: "new-keyword",
    expected: `\
---
title: "A simple test document"
author: Zettlr
keywords:
- one tag
- new-keyword
- Mixed-case-Tag
---

# A simple test document

This #document contains some tags as well as some edge-cases to test the ability
of the replaceTags function to properly replace tags within files.

It contains a YAML frontmatter that defines one keyword with a space in it that
cannot occur anywhere else in the document; as well as the #new-keyword that now
also occurs within here. And a #MiXeD-case-TaG.

For example, if we have a [link](#second-tag), it shouldn't be replaced.
Similarly with [link](example.com#second-tag).`,
  },
  {
    // No spaces -> spaces
    oldTag: "second-tag",
    newTag: "New keyword",
    expected: `\
---
title: "A simple test document"
author: Zettlr
keywords:
- one tag
- New keyword
- Mixed-case-Tag
---

# A simple test document

This #document contains some tags as well as some edge-cases to test the ability
of the replaceTags function to properly replace tags within files.

It contains a YAML frontmatter that defines one keyword with a space in it that
cannot occur anywhere else in the document; as well as the  that now
also occurs within here. And a #MiXeD-case-TaG.

For example, if we have a [link](#second-tag), it shouldn't be replaced.
Similarly with [link](example.com#second-tag).`,
  },
  {
    // Spaces -> No spaces
    oldTag: "one tag",
    newTag: "one-tag",
    expected: `\
---
title: "A simple test document"
author: Zettlr
keywords:
- one-tag
- second-tag
- Mixed-case-Tag
---

# A simple test document

This #document contains some tags as well as some edge-cases to test the ability
of the replaceTags function to properly replace tags within files.

It contains a YAML frontmatter that defines one keyword with a space in it that
cannot occur anywhere else in the document; as well as the #second-tag that now
also occurs within here. And a #MiXeD-case-TaG.

For example, if we have a [link](#second-tag), it shouldn't be replaced.
Similarly with [link](example.com#second-tag).`,
  },
  {
    // Case insensitive
    oldTag: "Mixed-case-Tag",
    newTag: "all-lowercase-tag",
    expected: `\
---
title: "A simple test document"
author: Zettlr
keywords:
- one tag
- second-tag
- all-lowercase-tag
---

# A simple test document

This #document contains some tags as well as some edge-cases to test the ability
of the replaceTags function to properly replace tags within files.

It contains a YAML frontmatter that defines one keyword with a space in it that
cannot occur anywhere else in the document; as well as the #second-tag that now
also occurs within here. And a #all-lowercase-tag.

For example, if we have a [link](#second-tag), it shouldn't be replaced.
Similarly with [link](example.com#second-tag).`,
  },
];

describe("Utility#replaceTags()", function () {
  for (const test of replaceTagsTesters) {
    it(`should replace the tag "${test.oldTag}" with "${test.newTag}"`, function () {
      strictEqual(replaceTags(testDocument, test.oldTag, test.newTag), test.expected);
    });
  }
});

/**
 * The tags that the file manager and the tag manager read from a document:
 * the FSAL parser is the oracle of a rename.
 */
function tagsOf(markdown: string): string[] {
  const descriptor: MDFileDescriptor = {
    dir: "/notes",
    path: "/notes/lattices.md",
    name: "lattices.md",
    ext: ".md",
    size: 0,
    id: "",
    tags: [],
    links: [],
    fileLinks: [],
    citekeys: [],
    bom: "",
    type: "file",
    wordCount: 0,
    charCount: 0,
    modtime: 0,
    creationtime: 0,
    linefeed: "\n",
    firstHeading: null,
    firstSentence: null,
    yamlTitle: undefined,
    aliases: [],
    frontmatter: null,
    references: {
      documentPath: "/notes/lattices.md",
      sourceHash: "",
      definitions: [],
      occurrences: [],
    },
  };
  getMarkdownFileParser("(\\d{14})", "link|title").parse(descriptor, markdown);
  return [...descriptor.tags].sort();
}

const renameTesters = [
  {
    name: "a number in a keyword list",
    document: "---\nkeywords:\n- 1997\n- topology\n---\n\nA note.\n",
    oldTag: "1997",
    newTag: "year-1997",
    tags: ["topology", "year-1997"],
  },
  {
    name: "a keyword list written as one comma-separated string",
    document: "---\nkeywords: algebra, lattice-theory\n---\n\nA note.\n",
    oldTag: "lattice-theory",
    newTag: "lattices",
    tags: ["algebra", "lattices"],
  },
  {
    name: "a tag in `tags` beside a `keywords` list",
    document: "---\nkeywords:\n- algebra\ntags:\n- genus\n---\n\nA note.\n",
    oldTag: "genus",
    newTag: "spinor-genus",
    tags: ["algebra", "spinor-genus"],
  },
  {
    name: "a new name that YAML must quote in a flow list",
    document: "---\nkeywords: [genus, lattice]\n---\n\nA note.\n",
    oldTag: "lattice",
    newTag: "lattice: even, unimodular",
    tags: ["genus", "lattice: even, unimodular"],
  },
  {
    name: "two spellings of one tag in a keyword list",
    document: "---\nkeywords:\n- lattice\n- Lattice\n- genus\n---\n\nA note.\n",
    oldTag: "lattice",
    newTag: "even-lattice",
    tags: ["even-lattice", "genus"],
  },
  {
    name: "an inline tag renamed to a name with a space, without front matter",
    document: "# Lattices\n\nA #second-tag in the text.\n",
    oldTag: "second-tag",
    newTag: "New keyword",
    tags: ["new keyword"],
  },
  {
    name: "an inline tag renamed to a name with a space, with a keyword list",
    document: "---\ntitle: Lattices\nkeywords:\n  - genus\n---\n\nA #second-tag in the text.\n",
    oldTag: "second-tag",
    newTag: "New keyword",
    tags: ["genus", "new keyword"],
  },
];

describe("Utility#replaceTags() gives the tags that the parser reads", function () {
  for (const test of renameTesters) {
    it(`renames ${test.name}`, function () {
      const renamed = replaceTags(test.document, test.oldTag, test.newTag);
      deepStrictEqual(tagsOf(renamed), test.tags);
    });
  }
});
