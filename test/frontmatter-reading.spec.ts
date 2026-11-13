/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Specs of the one reading of a YAML metadata block
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The descriptor of a file (`documentFrontmatter`) and the
 *                  hover preview, the link preview and the LanguageTool
 *                  language (`extractYamlFrontmatter`) read the metadata
 *                  block of a document as Pandoc reads it (#203). Pandoc's
 *                  `yamlMetaBlock` takes a closer with trailing spaces,
 *                  refuses an opener that a blank line follows, reads CRLF
 *                  text as LF text and takes a block after a paragraph. The
 *                  expected values are the output of `pandoc -f markdown -t
 *                  json` (3.11) for each document.
 *
 * END HEADER
 */

import { markdownToAST } from "@common/modules/markdown-utils";
import { documentFrontmatter } from "@common/util/document-frontmatter";
import extractYamlFrontmatter from "@common/util/extract-yaml-frontmatter";
import { strict as assert } from "assert";

const DOCUMENTS = [
  {
    name: "a closer with a trailing space",
    text: "---\ntitle: A\n--- \n\nBody\n",
    title: "A",
    body: "Body",
  },
  {
    name: "an opener that a blank line follows",
    text: "---\n\ntitle: A\n---\n\nBody\n",
    title: undefined,
    body: "--- title: A --- Body",
  },
  {
    name: "CRLF line ends",
    text: "---\r\ntitle: A\r\n---\r\n\r\nBody\r\n",
    title: "A",
    body: "Body",
  },
  {
    name: "a block after a paragraph",
    text: "Intro\n\n---\ntitle: A\n---\n\nBody\n",
    title: "A",
    body: "Intro Body",
  },
];

/** The words of a text, apart by one space. */
function words(text: string): string {
  return text.split(/\s+/u).join(" ").trim();
}

describe("The one reading of a YAML metadata block", function () {
  for (const { name, text, title, body } of DOCUMENTS) {
    it(`reads the title of a document with ${name} as Pandoc does`, function () {
      assert.equal(documentFrontmatter(markdownToAST(text))?.title, title, "the descriptor");
      assert.equal(extractYamlFrontmatter(text).frontmatter?.title, title, "the previews");
    });

    it(`gives the previews the text of a document with ${name} after its block`, function () {
      assert.equal(words(extractYamlFrontmatter(text).content), body);
    });
  }
});
