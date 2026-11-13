/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown Utilities
 * CVM-Role:        Utility Functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the main entry file for various Markdown utilities
 *                  needed throughout the app.
 *
 * END HEADER
 */

import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { type Parser, type Tree } from "@lezer/common";
import { LRUCache } from "lru-cache";
import {
  type ASTNode,
  type ASTNodeType,
  childNodes,
  type Document,
  parseNode,
  type TextNode,
} from "./markdown-ast";

export { md2html } from "./markdown-to-html";

/**
 * How a wikilink names its document: `[[link|title]]` or `[[title|link]]`
 * (the setting `zkn.linkFormat`). The parser reads the target of a wikilink
 * by it; no other node depends on it.
 */
export type WikilinkFormat = "link|title" | "title|link";

// The parser of each link format.
const parsers = new Map<WikilinkFormat, Parser>();

function parserFor(linkFormat: WikilinkFormat): Parser {
  const known = parsers.get(linkFormat);
  if (known !== undefined) {
    return known;
  }
  const { parser } = markdownParser({ zknLinkParserConfig: { format: linkFormat } }).language;
  parsers.set(linkFormat, parser);
  return parser;
}

// The ASTs of the sources that were parsed last, for each link format. One
// version of a document has several readers (references, citations, TikZ
// blocks, the lint context, the file parser, the save path); they share one
// parse. Eight entries hold the buffer text and the saved text of the
// documents that an edit touches.
const parsedSources = new LRUCache<string, Document | ASTNode>({ max: 8 });

/**
 * Converts a Markdown string into an AST, utilizing the CodeMirror Markdown
 * parser for the heavy lifting. This effectively takes a Lezer tree and
 * converts it to a custom Markdown AST implementation.
 *
 * @param   {string}   markdown  The Markdown source
 * @param   {Tree}     tree      Optional: If you already have a parsed tree,
 *                               you can pass it here to save some time re-
 *                               parsing the source. Please NOTE: If you pass in
 *                               a tree, you MUST pass the full Markdown source
 *                               that has been used to generate the parse tree,
 *                               since otherwise the offsets in the parse tree
 *                               will be wrong!
 *
 * @param   {WikilinkFormat} linkFormat  How a wikilink names its document.
 *                               A reader of wikilinks passes the setting
 *                               `zkn.linkFormat`; a tree carries its own.
 *
 * @return  {ASTNode}            The root node of the AST. Callers share it
 *                               and must not change it.
 */
export function markdownToAST(
  markdown: string,
  tree: Tree | null = null,
  linkFormat: WikilinkFormat = "link|title",
): Document | ASTNode {
  if (tree !== null) {
    return parseNode(tree.topNode, markdown);
  }

  const key = `${linkFormat}\n${markdown}`;
  const known = parsedSources.get(key);
  if (known !== undefined) {
    return known;
  }

  const ast = parseNode(parserFor(linkFormat).parse(markdown).topNode, markdown);
  parsedSources.set(key, ast);
  return ast;
}

/**
 * Extracts arbitrary AST nodes. Providing a NodeType that is not used within
 * the AST will return an empty array.
 *
 * @param   {ASTNode}      ast       The AST to extract nodes from
 * @param   {ASTNodeType}  nodeType  The Node type to query
 * @param   {Function}     filter    An optional filter. Receives a node and
 *                                   returns a boolean indicating if the node
 *                                   should be visited.
 *
 * @return  {ASTNode[]}              An array of all found nodes
 */
export function extractASTNodes(
  ast: ASTNode,
  nodeType: ASTNodeType,
  filter?: (node: ASTNode) => boolean,
): ASTNode[] {
  if (ast.type === "Document") {
    return ast.children.flatMap((child) => extractASTNodes(child, nodeType, filter));
  }

  if (filter !== undefined && !filter(ast)) {
    return [];
  }

  if (ast.type === nodeType) {
    return [ast];
  }

  return childNodes(ast).flatMap((child) => extractASTNodes(child, nodeType, filter));
}

/**
 * Extracts all text nodes from a Markdown AST. Can be used for spellchecking,
 * for example. An optional filter can be provided to exclude text nodes from
 * those nodes that should not be extracted.
 *
 * @param   {ASTNode[]}   ast     The AST root.
 * @param   {Function}    filter  A function that receives an ASTNode and should
 *                                return false if the node should be excluded.
 *
 * @return  {TextNode[]}          A list of all text nodes
 */
export function extractTextnodes(ast: ASTNode, filter?: (node: ASTNode) => boolean): TextNode[] {
  if (ast.type === "Document") {
    return ast.children.flatMap((child) => extractTextnodes(child, filter));
  }

  if (filter !== undefined && !filter(ast)) {
    return [];
  }

  if (ast.type === "Text") {
    return [ast];
  }

  const titles =
    (ast.type === "Link" || ast.type === "Image" || ast.type === "ZettelkastenLink") &&
    ast.title !== undefined
      ? [ast.title]
      : [];

  return childNodes(ast)
    .flatMap((child) => extractTextnodes(child, filter))
    .concat(titles);
}
