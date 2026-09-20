/**
 * Pandoc raw-TeX block grammar. Reference implementation: Pandoc 3.10.2
 * commit f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/LaTeX.hs `rawLaTeXBlock` (line 153).
 */

/** Pandoc-compatible block parser for raw non-math LaTeX environments. */

import {
  rawLatexBlockEndAtStart,
  rawLatexBlockSequenceEndAtStart,
  rawLatexBlockStartsAt,
  rawLatexInlineEndAtStart,
} from "./raw-latex-syntax";
import type { Input } from "@lezer/common";
import type { BlockContext, BlockParser, InlineParser, LeafBlock } from "../markdown";

function isLezerInput(value: unknown): value is Input {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, "read") === "function" &&
    typeof Reflect.get(value, "length") === "number"
  );
}

function blockInput(ctx: BlockContext): Input {
  const input: unknown = Reflect.get(ctx, "input");
  if (!isLezerInput(input)) {
    throw new Error("raw-latex-block parser requires Lezer BlockContext.input");
  }
  return input;
}

/**
 * Pandoc does not let a raw-TeX block preempt an inline construct that began
 * on an earlier physical line. In particular, Markdown.hs `symbol` only tests
 * `notFollowedBy rawTeXBlock` when the inline parser actually reaches that
 * backslash; higher-priority parsers such as `math` and `code` consume their
 * complete source first.
 *
 * Lezer decides whether a new block interrupts a leaf before it performs the
 * leaf's inline parse, so replay the fork's own inline parser here and suppress
 * the block boundary when an already-open inline node spans this position.
 * This is not a second syntax rule: the authoritative recognition is the same
 * configured Pandoc inline parser.
 */
function earlierInlineSpansPosition(
  ctx: BlockContext,
  leaf: LeafBlock,
  position: number,
): boolean {
  const input = blockInput(ctx);
  const source = input.read(leaf.start, input.length);
  return ctx.parser
    .parseInline(source, leaf.start)
    .some(element => element.from < position && element.to > position);
}

export const rawLatexBlockParser: BlockParser = {
  name: "raw-latex-block",
  before: "HTMLBlock",

  endLeaf: (ctx, line, leaf) => {
    if (!rawLatexBlockStartsAt(line.text.slice(line.pos))) {
      return false;
    }
    const position = ctx.lineStart + line.pos;
    return !earlierInlineSpansPosition(ctx, leaf, position);
  },

  parse: (ctx, line) => {
    if (!rawLatexBlockStartsAt(line.text.slice(line.pos))) {
      return false;
    }

    const absoluteStart = ctx.parsedPos + line.pos;
    const remaining = blockInput(ctx).read(absoluteStart, blockInput(ctx).length);
    const relativeEnd = rawLatexBlockSequenceEndAtStart(remaining);
    if (relativeEnd === null) {
      return false;
    }
    const absoluteEnd = absoluteStart + relativeEnd;
    const blockStart = ctx.lineStart + line.pos;
    const content: ReturnType<BlockContext["elt"]>[] = [];
    let firstLine = true;

    // Advance only after a complete closing environment is known to exist.
    // This keeps an unterminated environment ordinary editable source rather
    // than consuming the rest of the document speculatively.
    ctx.beginOpaqueBlock();
    try {
      while (absoluteEnd > ctx.parsedPos + line.text.length) {
        const contentFrom = ctx.lineStart + (firstLine ? line.pos : line.basePos);
        const contentTo = ctx.lineStart + line.text.length + 1;
        content.push(ctx.elt("RawBlockContent", contentFrom, contentTo));
        firstLine = false;
        if (!ctx.nextLine()) {
          return false;
        }
      }
    } finally {
      ctx.endOpaqueBlock();
    }

    const closePos = absoluteEnd - ctx.parsedPos;
    const blockEnd = ctx.lineStart + closePos;
    const finalFrom = ctx.lineStart + (firstLine ? line.pos : line.basePos);
    content.push(ctx.elt("RawBlockContent", finalFrom, blockEnd));
    ctx.addElement(ctx.elt("RawBlock", blockStart, blockEnd, content));

    // Pandoc permits ordinary Markdown after the closing environment on the
    // same physical line. Leave that suffix for the normal block parser.
    if (line.text.slice(closePos).trim() !== "") {
      line.moveBase(closePos);
      return null;
    }

    ctx.nextLine();
    return true;
  },
};

/**
 * Pandoc RawInline(tex) adapter. Math delimiters run before this parser; raw
 * TeX runs before CommonMark's Escape parser, matching Markdown.hs where
 * `math <|> escaped... <|> rawLaTeXInline'` decides a backslash-led inline.
 */
export const rawLatexInlineParser: InlineParser = {
  name: "raw-latex-inline",
  before: "Escape",
  parse: (ctx, next, pos) => {
    if (next !== 92) { // backslash
      return -1;
    }
    const localFrom = pos - ctx.offset;
    const relativeEnd = rawLatexInlineEndAtStart(ctx.text.slice(localFrom));
    if (relativeEnd === null) {
      return -1;
    }
    const to = pos + relativeEnd;
    return ctx.addElement(ctx.elt("RawInline", pos, to, [
      ctx.elt("RawInlineContent", pos, to),
    ]));
  },
};
