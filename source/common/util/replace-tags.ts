/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Replace Tags
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This function can replace a set of tags across a file
 *
 * END HEADER
 */

import { extractASTNodes, markdownToAST } from "@common/modules/markdown-utils";
import type { YAMLFrontmatter, ZettelkastenTag } from "@common/modules/markdown-utils/markdown-ast";
import { isMap, isScalar, isSeq, parseDocument, type Scalar, stringify, type YAMLSeq } from "yaml";

/**
 * The keys of the front matter that hold tags. The FSAL parser
 * (`fsal/util/file-parser.ts`) reads the same keys in the same way: a list, or
 * one value that a comma divides into tags.
 */
const TAG_KEYS = ["keywords", "tags"];

interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * The text of one tag as a value of block YAML (a `- item` or `key: value`).
 */
function blockText(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

/**
 * The text of one tag as an item of a flow list (`[a, b]`), where a comma or a
 * bracket ends a plain value.
 */
function flowItemText(value: string): string {
  const list = stringify([value], {
    collectionStyle: "flow",
    flowCollectionPadding: false,
    lineWidth: 0,
  }).trim();
  return list.slice(1, -1);
}

/**
 * The text of a list of tags as the value of a key. One value that a comma
 * divides keeps that form while no tag has a comma; otherwise it is a flow list.
 */
function listText(tags: string[]): string {
  if (tags.some((tag) => tag.includes(","))) {
    return `[${tags.map(flowItemText).join(", ")}]`;
  }
  return blockText(tags.join(", "));
}

/**
 * The tags of a scalar value, as the FSAL parser divides them.
 */
function scalarTags(node: Scalar): string[] {
  const value = String(node.value);
  const parts = value.split(",");
  return parts.length > 1 ? parts.map((part) => part.trim()) : [value];
}

/**
 * Takes a Markdown document and replaces all occurrences of oldTag with newTag:
 * the inline tags and the tags of the `keywords` and `tags` keys of the front
 * matter. A tag with a space can only be in the front matter, so an inline tag
 * renamed to such a name goes into the front matter.
 *
 * @param   {string}        markdown  The document in question
 * @param   {string}        oldTag    The old tag to be replaced
 * @param   {string}        newTag    The new tag to replace the old one
 *
 * @return  {string}                  The new document
 */
export default function replaceTags(markdown: string, oldTag: string, newTag: string): string {
  const sanitizedOldTag = oldTag.toLowerCase();
  const newTagHasSpaces = /\s/.test(newTag);
  const ast = markdownToAST(markdown);
  const edits: TextEdit[] = [];

  let removedInlineTag = false;
  for (const tagNode of extractASTNodes(ast, "ZettelkastenTag") as ZettelkastenTag[]) {
    if (tagNode.value.toLowerCase() !== sanitizedOldTag) {
      continue;
    }
    edits.push({ from: tagNode.from, to: tagNode.to, insert: newTagHasSpaces ? "" : `#${newTag}` });
    removedInlineTag ||= newTagHasSpaces;
  }

  const linefeed = markdown.includes("\r\n") ? "\r\n" : "\n";
  const [frontmatter] = extractASTNodes(ast, "YAMLFrontmatter") as YAMLFrontmatter[];
  let frontmatterHoldsNewTag = false;
  let tagList: { offset: number; node: YAMLSeq | Scalar; tags: string[] } | undefined;
  let mapEnd: number | undefined;

  if (frontmatter !== undefined) {
    const offset = markdown.indexOf("\n", frontmatter.from) + 1;
    if (!markdown.startsWith(frontmatter.source, offset)) {
      throw new Error("The front matter of the document does not start on its second line.");
    }
    const document = parseDocument(frontmatter.source);
    const sanitizedNewTag = newTag.toLowerCase();
    if (document.errors.length === 0 && (isMap(document.contents) || document.contents === null)) {
      mapEnd = offset + frontmatter.source.length;
      for (const key of TAG_KEYS) {
        const node = document.get(key, true);
        if (isSeq(node)) {
          const tags: string[] = [];
          for (const item of node.items) {
            if (!isScalar(item) || item.range == null) {
              continue;
            }
            const tag = String(item.value);
            if (tag.toLowerCase() !== sanitizedOldTag) {
              frontmatterHoldsNewTag ||= tag.toLowerCase() === sanitizedNewTag;
              tags.push(tag);
              continue;
            }
            tags.push(newTag);
            frontmatterHoldsNewTag = true;
            edits.push({
              from: offset + item.range[0],
              to: offset + item.range[1],
              insert: node.flow === true ? flowItemText(newTag) : blockText(newTag),
            });
          }
          tagList ??= { offset, node, tags };
        } else if (isScalar(node) && node.value !== null && node.range != null) {
          const original = scalarTags(node);
          frontmatterHoldsNewTag ||= original.some((tag) => tag.toLowerCase() === sanitizedNewTag);
          const tags = original.map((tag) =>
            tag.toLowerCase() === sanitizedOldTag ? newTag : tag,
          );
          if (tags.some((tag, index) => tag !== original[index])) {
            frontmatterHoldsNewTag = true;
            edits.push({
              from: offset + node.range[0],
              to: offset + node.range[1],
              insert: listText(tags),
            });
          }
          tagList ??= { offset, node, tags };
        }
      }
    }
  }

  if (removedInlineTag && !frontmatterHoldsNewTag) {
    edits.push(addToFrontmatter(markdown, frontmatter, mapEnd, tagList, newTag, linefeed));
  }

  edits.sort((a, b) => b.from - a.from);
  for (const edit of edits) {
    markdown = markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to);
  }
  return markdown;
}

/**
 * The edit that adds a tag to the front matter: to the first tag key that the
 * front matter has, as a new key of the front matter, or in a new front matter.
 */
function addToFrontmatter(
  markdown: string,
  frontmatter: YAMLFrontmatter | undefined,
  mapEnd: number | undefined,
  tagList: { offset: number; node: YAMLSeq | Scalar; tags: string[] } | undefined,
  newTag: string,
  linefeed: string,
): TextEdit {
  const newKey = `keywords:${linefeed}  - ${blockText(newTag)}`;
  if (frontmatter === undefined) {
    return {
      from: 0,
      to: 0,
      insert: `---${linefeed}${newKey}${linefeed}---${linefeed}${linefeed}`,
    };
  }
  if (frontmatter.source === "") {
    const lineEnd = markdown.indexOf("\n", frontmatter.from) + 1;
    return { from: lineEnd, to: lineEnd, insert: `${newKey}${linefeed}` };
  }
  if (mapEnd === undefined) {
    throw new Error(
      `The front matter of the document is no YAML mapping, so the tag "${newTag}" cannot be added to it.`,
    );
  }
  if (tagList === undefined) {
    return { from: mapEnd, to: mapEnd, insert: `${linefeed}${newKey}` };
  }

  const { offset, node, tags } = tagList;
  if (node.range == null) {
    throw new Error(
      `The tag list of the front matter has no position, so the tag "${newTag}" cannot be added to it.`,
    );
  }
  const [start, end] = node.range;
  if (isScalar(node)) {
    return { from: offset + start, to: offset + end, insert: listText([...tags, newTag]) };
  }
  if (node.flow === true) {
    const close = markdown.lastIndexOf("]", offset + end);
    const separator = node.items.length > 0 ? ", " : "";
    return { from: close, to: close, insert: `${separator}${flowItemText(newTag)}` };
  }
  const last = node.items[node.items.length - 1];
  if (!isScalar(last) || last.range == null) {
    throw new Error(
      `The last item of the tag list is no tag, so the tag "${newTag}" cannot be added to it.`,
    );
  }
  const itemStart = offset + last.range[0];
  const lineStart = markdown.lastIndexOf("\n", itemStart - 1) + 1;
  const prefix = markdown.slice(lineStart, itemStart);
  const lineEnd = markdown.indexOf(linefeed, offset + last.range[1]);
  const at = lineEnd < 0 ? offset + end : lineEnd;
  return { from: at, to: at, insert: `${linefeed}${prefix}${blockText(newTag)}` };
}
