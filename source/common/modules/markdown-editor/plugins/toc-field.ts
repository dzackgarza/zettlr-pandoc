/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table of Contents field
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This state field keeps an updated table of contents for
 *                  Markdown documents. The identifier of each heading is the
 *                  identifier that Pandoc's Markdown reader gives it (#203).
 *
 * END HEADER
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, StateField, type Text } from "@codemirror/state";
import { parsePandocAttributes } from "@common/pandoc-util/parse-pandoc-attributes";
import { markdownHeadingLevel } from "@dzack/pandoc-editor/util/heading-level";
import type { SyntaxNode } from "@lezer/common";
import { decodeHTMLStrict } from "entities";

/** Nodes whose text Pandoc's `stringify` leaves out of an identifier. */
const NO_TEXT = new Set(["URL", "LinkTitle", "PandocAttribute", "HTMLTag", "Comment", "RawInline"]);

/**
 * The text that Pandoc's `stringify` gives the inlines of a heading, from the
 * Lezer tree. Reference: Pandoc 3.10.2, Text.Pandoc.Shared `stringify` and
 * the Markdown reader. Code and math give their source; a raw inline, an
 * HTML tag and a comment give nothing; an inline link and an image give
 * their text; a reference link and a footnote reference give their source,
 * as Pandoc reads them before it resolves the reference; an inline note
 * gives nothing. Smart punctuation turns `...`, `--` and `---` into
 * characters that no identifier keeps.
 */
function inlineText(doc: Text, parent: SyntaxNode, from: number, to: number): string {
  let text = "";
  let pos = from;
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (child.to <= from || child.from >= to || child.from < pos) {
      continue;
    }
    text += smartText(doc.sliceString(pos, child.from));
    pos = child.to;
    if (child.name === "InlineCode") {
      const rawFormat = /^\{=[^\s{}]+\}/u.exec(doc.sliceString(pos, Math.min(to, pos + 64)));
      if (rawFormat !== null) {
        pos += rawFormat[0].length;
        continue;
      }
    }
    text += nodeText(doc, child);
  }
  return text + smartText(doc.sliceString(pos, to));
}

function smartText(text: string): string {
  return text.replaceAll("...", "\u2026").replaceAll("---", "\u2014").replaceAll("--", "\u2013");
}

function nodeText(doc: Text, node: SyntaxNode): string {
  const source = doc.sliceString(node.from, node.to);
  if (NO_TEXT.has(node.name) || node.name.endsWith("Mark")) {
    return "";
  }
  switch (node.name) {
    case "Escape":
      return source.slice(1);
    case "Entity":
      return decodeHTMLStrict(source);
    case "Citation":
      return source;
    case "Footnote":
      return source.startsWith("^[") ? "" : source;
    case "InlineCode": {
      const open = node.firstChild;
      const close = node.lastChild;
      if (open === null || close === null || open === close) {
        return source;
      }
      return doc.sliceString(open.to, close.from);
    }
    case "Link":
    case "Image": {
      if (node.getChild("LinkLabel") !== null) {
        return source;
      }
      const open = node.firstChild;
      let close = open === null ? null : open.nextSibling;
      while (
        close !== null &&
        !(close.name === "LinkMark" && doc.sliceString(close.from, close.to) === "]")
      ) {
        close = close.nextSibling;
      }
      if (open === null || close === null) {
        return source;
      }
      return inlineText(doc, node, open.to, close.from);
    }
  }
  return node.firstChild === null ? source : inlineText(doc, node, node.from, node.to);
}

/**
 * Pandoc's identifier of a heading text without the extensions
 * `gfm_auto_identifiers` and `ascii_identifiers`. Reference: Pandoc 3.10.2,
 * Text.Pandoc.Shared `inlineListToIdentifier`: lowercase, keep letters,
 * numbers, `_`, `-`, `.` and whitespace, join the words with `-`, drop all
 * up to the first letter.
 */
function pandocIdentifier(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.\-\s]/gu, "")
    .split(/\s+/u)
    .filter((word) => word !== "");
  return words.join("-").replace(/^\P{L}+/u, "");
}

/**
 * Pandoc's `uniqueIdent`: an identifier that a heading before it has gets
 * `-1`, `-2` and so on; an empty identifier is `section`.
 */
function uniqueIdentifier(base: string, used: Set<string>): string {
  const identifier = base === "" ? "section" : base;
  if (!used.has(identifier)) {
    return identifier;
  }
  let suffix = 1;
  while (used.has(`${identifier}-${suffix}`)) {
    suffix++;
  }
  return `${identifier}-${suffix}`;
}

/**
 * The identifier of the attribute block `{#id …}` at the end of a heading.
 * An attribute block right after inline code belongs to the code.
 */
function explicitIdentifier(
  doc: Text,
  heading: SyntaxNode,
  contentEnd: number,
): string | undefined {
  const attributes = heading.getChildren("PandocAttribute").at(-1);
  if (attributes === undefined || doc.sliceString(attributes.to, contentEnd).trim() !== "") {
    return undefined;
  }
  const before = attributes.prevSibling;
  if (before !== null && before.name === "InlineCode" && before.to === attributes.from) {
    return undefined;
  }
  return parsePandocAttributes(doc.sliceString(attributes.from, attributes.to)).id;
}

export interface ToCEntry {
  /**
   * The one-indexed line number of the heading
   */
  line: number;
  /**
   * The character where the entry begins
   */
  pos: number;
  /**
   * The text contents of the heading (without the heading formatting)
   */
  text: string;
  /**
   * The level of the heading. Pandoc permits ATX heading levels above six.
   */
  level: number;
  /**
   * A human-readable title numbering (e.g. 1.2, 2.5.1)
   */
  renderedLevel: string;
  /**
   * An ID used to link to this heading
   */
  id: string;
}

/**
 * This function generates a Table of Contents based on the EditorState
 *
 * @param   {EditorState}  state  The editor state to create a ToC from
 *
 * @return  {ToCEntry[]}          The ToC
 */
function generateToc(state: EditorState): ToCEntry[] {
  const toc: ToCEntry[] = [];
  const counters: number[] = [];
  const usedIdentifiers = new Set<string>();

  // We try to retrieve the full syntax tree, and if that fails, fall back to
  // the (possibly incomplete) syntax tree. For the ToC we definitely want to
  // utilize the full tree.
  let tree = ensureSyntaxTree(state, state.doc.length, 1000);
  if (tree === null) {
    tree = syntaxTree(state);
  }

  tree.iterate({
    enter(node) {
      if (node.type.is("Document") || node.type.is("PandocDiv")) {
        return;
      }

      const level = markdownHeadingLevel(node.node);
      if (level === null) {
        return false;
      }

      while (counters.length < level) counters.push(0);
      counters[level - 1]++;
      for (let i = level; i < counters.length; i++) counters[i] = 0;

      let from = node.from;
      let to = node.to;
      if (node.type.name === "ATXHeading") {
        const marks = node.node.getChildren("HeaderMark");
        const mark = marks.at(0);
        if (mark === undefined) return false;
        from = mark.to;
        const closing = marks.at(1);
        if (closing !== undefined) to = closing.from;
        while (from < node.to && /[ \t]/u.test(state.doc.sliceString(from, from + 1))) from++;
      } else {
        const mark = node.node.getChild("HeaderMark");
        if (mark === null) return false;
        to = mark.from;
      }
      const text = state.doc.sliceString(from, to).trimEnd();
      const explicit = explicitIdentifier(state.doc, node.node, to);
      const id =
        explicit !== undefined
          ? explicit
          : uniqueIdentifier(
              pandocIdentifier(inlineText(state.doc, node.node, from, to)),
              usedIdentifiers,
            );
      usedIdentifiers.add(id);
      toc.push({
        line: state.doc.lineAt(node.from).number,
        pos: node.from,
        text,
        level,
        renderedLevel: counters.slice(0, level).join("."),
        id,
      });
      return false;
    },
  });

  return toc;
}

export const tocField = StateField.define<ToCEntry[]>({
  create(state) {
    return generateToc(state);
  },

  update(value, transaction) {
    if (!transaction.docChanged) {
      return value;
    }

    return generateToc(transaction.state);
  },
});
