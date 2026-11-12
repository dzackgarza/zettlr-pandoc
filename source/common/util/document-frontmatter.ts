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
