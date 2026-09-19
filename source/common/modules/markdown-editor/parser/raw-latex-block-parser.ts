/** Pandoc-compatible block parser for raw non-math LaTeX environments. */

import { rawLatexBlockEndAtStart, rawLatexBlockStartsAt } from "@common/util/raw-latex-block";
import type { Input } from "@lezer/common";
import type { BlockContext, BlockParser } from "@lezer/markdown";

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

export const rawLatexBlockParser: BlockParser = {
  name: "raw-latex-block",
  before: "HTMLBlock",

  endLeaf: (_ctx, line) => rawLatexBlockStartsAt(line.text.slice(line.pos)),

  parse: (ctx, line) => {
    if (!rawLatexBlockStartsAt(line.text.slice(line.pos))) {
      return false;
    }

    const absoluteStart = ctx.parsedPos + line.pos;
    const remaining = blockInput(ctx).read(absoluteStart, blockInput(ctx).length);
    const relativeEnd = rawLatexBlockEndAtStart(remaining);
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
    while (absoluteEnd > ctx.parsedPos + line.text.length) {
      const contentFrom = ctx.lineStart + (firstLine ? line.pos : line.basePos);
      const contentTo = ctx.lineStart + line.text.length + 1;
      content.push(ctx.elt("RawBlockContent", contentFrom, contentTo));
      firstLine = false;
      if (!ctx.nextLine()) {
        return false;
      }
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
