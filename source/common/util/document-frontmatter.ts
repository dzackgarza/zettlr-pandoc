/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        documentFrontmatter
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The YAML front matter of a parsed Markdown document, as
 *                  the file parser of the FSAL stores it in a descriptor.
 *
 * END HEADER
 */

import { extractASTNodes } from "@common/modules/markdown-utils";
import type { ASTNode, YAMLFrontmatter } from "@common/modules/markdown-utils/markdown-ast";
import type { YamlMapping, YamlValue } from "@dts/common/fsal";
import type { Tree } from "@lezer/common";
import { parse as parseYAML, YAMLError } from "yaml";

/**
 * The mapping of the first front matter block of `ast`. A document without
 * front matter, with an empty block or with invalid YAML has none (`null`);
 * a block that holds a scalar or a list is an empty mapping.
 */
export function documentFrontmatter(ast: ASTNode): YamlMapping | null {
  const blocks = extractASTNodes(ast, "YAMLFrontmatter") as YAMLFrontmatter[];
  if (blocks.length === 0) {
    return null;
  }
  let frontmatter: YamlValue | undefined;
  try {
    // The core schema of `yaml` yields JSON-like values with string keys.
    frontmatter = parseYAML(blocks[0].source);
  } catch (err) {
    // Invalid YAML is a document without front matter; every other failure
    // is a defect.
    if (!(err instanceof YAMLError)) {
      throw err;
    }
    return null;
  }
  if (frontmatter === null || frontmatter === undefined) {
    return null;
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return {};
  }
  return frontmatter;
}

/** The source ranges of a YAML metadata block and of its YAML text. */
export interface MetadataBlockRange {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
}

// The blocks that hold blocks: a metadata block can be in one of them
const BLOCK_CONTAINERS = new Set([
  "Document",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
  "PandocDiv",
]);

/**
 * The first metadata block of a syntax tree: the block that
 * `documentFrontmatter` reads from the AST of the same text. A caller that
 * has a tree, such as an editor, reads the block without a second parse.
 */
export function firstMetadataBlock(tree: Tree): MetadataBlockRange | null {
  let block: MetadataBlockRange | null = null;
  tree.iterate({
    enter(node) {
      if (block !== null) {
        return false;
      }
      if (node.name === "YAMLFrontmatter") {
        const body = node.node.getChild("CodeText");
        if (body === null) {
          throw new Error(`The metadata block at ${node.from} has no YAML text node`);
        }
        block = { from: node.from, to: node.to, bodyFrom: body.from, bodyTo: body.to };
        return false;
      }
      return BLOCK_CONTAINERS.has(node.name);
    },
  });
  return block;
}
