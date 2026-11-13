/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Specs of the inlines inside a link or a note
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Pandoc reads the text of a link, the description of an
 *                  image and the text of an inline note as inlines: a
 *                  citation, emphasis and code in it are elements of the
 *                  document (#203). The descriptor of a file
 *                  cites each key that Pandoc cites, and md2html gives the
 *                  text of a link the elements that Pandoc gives it. The
 *                  executable Pandoc 3.10.2 reader is the oracle.
 *
 * END HEADER
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "assert";
import { parse as parseFile } from "source/app/service-providers/fsal/fsal-file";
import getMarkdownFileParser from "source/app/service-providers/fsal/util/file-parser";
import { md2html } from "source/common/modules/markdown-utils/markdown-to-html";
import { execPandocReference } from "./pandoc-reference";

interface PandocElement {
  t?: string;
  c?: unknown;
}

function pandocCitationIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => pandocCitationIds(item));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const element = value as PandocElement;
  if (element.t === "Cite") {
    const [citations] = element.c as [Array<{ citationId: string }>, unknown];
    return citations.map((citation) => citation.citationId);
  }
  return pandocCitationIds(element.c);
}

function pandocCitekeys(markdown: string): string[] {
  const raw = execPandocReference(["-f", "markdown", "-t", "json"], { input: markdown });
  return pandocCitationIds((JSON.parse(raw) as { blocks: unknown }).blocks);
}

/** The content of the first `<a>` element of an HTML fragment. */
function linkContent(html: string): string {
  const match = /<a\b[^>]*>(.*?)<\/a>/su.exec(html);
  assert.notEqual(match, null, `no link in ${html}`);
  return (match as RegExpExecArray)[1];
}

describe("inlines inside a link or a note", function () {
  let workspace: string;

  beforeEach(async function () {
    workspace = await mkdtemp(path.join(os.tmpdir(), "zettlr-link-text-"));
  });

  afterEach(async function () {
    await rm(workspace, { recursive: true, force: true });
  });

  const citationCases: Array<[string, string]> = [
    ["a link", "See [the proof of @CS10](https://example.org/proof).\n"],
    ["an image description", "See ![the lattice of @CS10](lattice.png) here.\n"],
    ["a bracketed citation in a link", "See [the proof [@CS10, p. 3]](https://example.org).\n"],
    ["an inline note", "A lattice.^[See @CS10, p. 3, for the proof.]\n"],
    ["a bracketed citation in an inline note", "A lattice.^[The proof [@CS10, p. 3] uses it.]\n"],
  ];

  for (const [name, markdown] of citationCases) {
    it(`cites in the file descriptor each key that Pandoc cites in ${name}`, async function () {
      const file = path.join(workspace, "note.md");
      await writeFile(file, markdown, "utf8");
      const descriptor = await parseFile(
        file,
        null,
        getMarkdownFileParser("(\\d{14})", "link|title"),
      );
      assert.deepEqual(descriptor.citekeys, pandocCitekeys(markdown));
    });
  }

  it("gives the text of a link the elements that Pandoc gives it", async function () {
    const markdown = "See [the *genus* of **even** forms](https://example.org/genus).\n";
    const html = await md2html(markdown, {
      onCitation: () => undefined,
      zknLinkFormat: "link|title",
    });
    const pandoc = execPandocReference(["-f", "markdown", "-t", "html", "--wrap=none"], {
      input: markdown,
    });
    assert.equal(linkContent(html), linkContent(pandoc));
  });
});
