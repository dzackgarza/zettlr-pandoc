/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FileParser
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Ery
 * License:         GNU GPL v3
 *
 * Description:     This utility function takes a file descriptor and some file
 *                  contents and then parses the contents into the descriptor.
 *
 * END HEADER
 */

import { extractASTNodes, markdownToAST } from "@common/modules/markdown-utils";
import type {
  CitationNode,
  YAMLFrontmatter,
  ZettelkastenLink,
  ZettelkastenTag,
} from "@common/modules/markdown-utils/markdown-ast";
import { extractReferencesFromAST } from "@common/pandoc-util/extract-references";
import { countAll } from "@common/util/counter";
import { documentTitleMetadataFromAST } from "@common/util/document-title-metadata";
import type { MDFileDescriptor, YamlValue } from "@dts/common/fsal";
import { parse as parseYAML, YAMLError } from "yaml";
import { getAppServiceContainer, isAppServiceContainerReady } from "../../../app-service-container";
import extractBOM from "./extract-bom";
import extractFileId from "./extract-file-id";
import { extractLinefeed } from "./extract-linefeed";

/**
 * Parses some Markdown `content` into the properties of the `file` descriptor.
 *
 * @param  {string}  idREPattern  The ID RegExp pattern as indicated by the user
 *
 * @returns {Function}            A parser that can then be used to parse files
 */
export default function getMarkdownFileParser(
  idREPattern: string,
): (file: MDFileDescriptor, content: string) => void {
  return function parseMarkdownFile(file: MDFileDescriptor, content: string): void {
    // First of all, determine all the things that have nothing to do with any
    // Markdown contents.
    file.bom = extractBOM(content);
    file.linefeed = extractLinefeed(content);
    file.id = extractFileId(file.name, content, idREPattern);

    const ast = markdownToAST(content);

    const tags = extractASTNodes(ast, "ZettelkastenTag") as ZettelkastenTag[];
    file.tags = tags.map((tag) => tag.value.toLowerCase());

    const links = extractASTNodes(ast, "ZettelkastenLink") as ZettelkastenLink[];
    file.links = links.map((link) => link.target);

    const citations = extractASTNodes(ast, "Citation") as CitationNode[];
    file.citekeys = citations.flatMap((node) => node.parsedCitation.items.map((item) => item.id));

    // Extract the document's reference surface from the same parse pass
    // (issue #1): the descriptor snapshot can never diverge from the shared
    // extractor's output over identical content.
    file.references = extractReferencesFromAST(file.path, content, ast);

    const titleMetadata = documentTitleMetadataFromAST(ast);
    file.firstHeading = titleMetadata.firstHeading;
    file.firstSentence = titleMetadata.firstSentence;

    const locale: string | undefined = isAppServiceContainerReady()
      ? getAppServiceContainer().config.get("appLang")
      : undefined;

    const counts = countAll(ast, locale);

    file.wordCount = counts.words;
    file.charCount = counts.chars;

    // Reset frontmatter-related stuff
    file.yamlTitle = undefined;
    file.aliases = [];
    file.frontmatter = null;

    const frontmatterNodes = extractASTNodes(ast, "YAMLFrontmatter") as YAMLFrontmatter[];
    if (frontmatterNodes.length === 0) {
      return; // Nothing more to do
    }

    try {
      // The core schema of `yaml` yields JSON-like values with string keys.
      const frontmatter: YamlValue | undefined = parseYAML(frontmatterNodes[0].source);

      if (frontmatter === null || frontmatter === undefined) {
        // An empty frontmatter carries no title, aliases or tags.
        file.frontmatter = null;
        return;
      }

      if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
        // A scalar or a list frontmatter carries no title, aliases or tags.
        file.frontmatter = {};
        return;
      }

      file.frontmatter = frontmatter;

      // Extract the frontmatter title if applicable
      if ("title" in frontmatter && typeof frontmatter.title === "string") {
        const title = frontmatter.title.trim();
        if (title !== "") {
          file.yamlTitle = title;
        }
      }

      // Obsidian's `aliases`: one name or a list of names
      if ("aliases" in frontmatter) {
        const aliases: YamlValue[] = Array.isArray(frontmatter.aliases)
          ? frontmatter.aliases
          : [frontmatter.aliases];
        file.aliases = aliases
          .filter(
            (alias): alias is string | number =>
              typeof alias === "string" || typeof alias === "number",
          )
          .map((alias) => String(alias).trim())
          .filter((alias) => alias !== "");
      }

      for (const prop of ["keywords", "tags"]) {
        const declared = frontmatter[prop];
        if (declared == null) {
          continue;
        }
        // The user can just write "keywords: something", in which case it won't be
        // an array, but a simple string (or even a number <.<). I am beginning to
        // understand why programmers despise the YAML-format.
        let keywords: YamlValue[];
        if (typeof declared === "string") {
          const keys = declared.split(",");
          // The user may have split the tags by comma
          keywords = keys.length > 1 ? keys.map((tag) => tag.trim()) : [declared];
        } else if (Array.isArray(declared)) {
          keywords = declared;
        } else {
          // It's likely a Number or a Boolean
          keywords = [String(declared)];
        }
        frontmatter[prop] = keywords;

        // If the user decides to use just numbers for the keywords (e.g. #1997),
        // the YAML parser will obviously cast those to numbers, but we don't want
        // this, so forcefully cast everything to string (see issue #1433).
        const sanitizedKeywords = keywords.map(String).map((tag) => tag.toLowerCase());
        file.tags.push(...sanitizedKeywords.filter((each) => !file.tags.includes(each)));
      }
    } catch (err) {
      // Invalid YAML leaves the descriptor without frontmatter metadata; every
      // other failure is a defect in this parser.
      if (!(err instanceof YAMLError)) {
        throw err;
      }
    }
  };
}
