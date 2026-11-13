/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        splitWikilinkTarget, wikilinkTargetsIn
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The targets of the wikilinks of a document. This module
 *                  imports no Node module: the renderer bundle maps Node's
 *                  `path` to an empty module, so the editor cannot import the
 *                  resolver.
 *
 * END HEADER
 */

import { extractASTNodes } from "../modules/markdown-utils";
import type { ASTNode, ZettelkastenLink } from "../modules/markdown-utils/markdown-ast";

/**
 * Splits the text before a wikilink's `|` label into the document target and
 * the `#heading` fragment.
 */
export function splitWikilinkTarget(raw: string): { target: string; fragment: string | undefined } {
  const hash = raw.indexOf("#");
  if (hash < 0) {
    return { target: raw.trim(), fragment: undefined };
  }
  return { target: raw.slice(0, hash).trim(), fragment: raw.slice(hash + 1).trim() };
}

/**
 * Every wikilink target of a document, before its `#` fragment: the target of
 * each `ZettelkastenLink` node of its AST. The parser reads the target by the
 * link format (`zkn.linkFormat`), and text in code holds no link.
 */
export function wikilinkTargetsIn(ast: ASTNode): string[] {
  const targets = new Set<string>();
  for (const link of extractASTNodes(ast, "ZettelkastenLink") as ZettelkastenLink[]) {
    const { target } = splitWikilinkTarget(link.target);
    if (target !== "") {
      targets.add(target);
    }
  }
  return [...targets];
}
