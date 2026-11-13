/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Extracts a YAML frontmatter
 *
 * END HEADER
 */

import { extractASTNodes, markdownToAST } from "@common/modules/markdown-utils";
import { documentFrontmatter } from "@common/util/document-frontmatter";
import type { YamlMapping } from "@dts/common/fsal";
import type { Tree } from "@lezer/common";

interface ExtractYamlFrontmatterReturn {
  frontmatter: YamlMapping | null;
  content: string;
}

/**
 * The front matter of a Markdown document and its text without the block.
 * The block is the one that the descriptor of the file reads
 * (`documentFrontmatter`): the first YAML metadata block of the syntax tree,
 * which follows Pandoc's `yamlMetaBlock` (#203).
 *
 * @param   {string}     markdown  The Markdown source
 * @param   {Tree|null}  tree      The syntax tree of `markdown`, when the caller has it
 */
export default function extractYamlFrontmatter(
  markdown: string,
  tree: Tree | null = null,
): ExtractYamlFrontmatterReturn {
  const ast = markdownToAST(markdown, tree);
  const [block] = extractASTNodes(ast, "YAMLFrontmatter");
  if (block === undefined) {
    return { frontmatter: null, content: markdown };
  }
  return {
    frontmatter: documentFrontmatter(ast),
    content: markdown.slice(0, block.from) + markdown.slice(block.to),
  };
}
