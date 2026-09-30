/**
 * Line lookahead over the block input.
 *
 * A Lezer BlockParser cannot roll BlockContext back after `nextLine()`, so a
 * Pandoc rule that needs lookahead reads the input ahead of the context. The
 * input is read in growing windows: a lookahead that stops after a few lines
 * reads a few lines, not the rest of the document.
 */

import type { Input } from "@lezer/common";

const FIRST_WINDOW = 2048;

export interface InputLine {
  /** Document offset of the first character of the line. */
  from: number;
  /** The line without its line feed. */
  text: string;
}

/**
 * The physical lines of `input` that start at or after `from`. The sequence
 * is the one `input.read(from, input.length).split("\n")` gives.
 */
export function* linesFrom(input: Input, from: number): Generator<InputLine> {
  let text = "";
  let textFrom = from;
  let lineFrom = from;
  let window = FIRST_WINDOW;

  for (;;) {
    let newline = text.indexOf("\n", lineFrom - textFrom);
    while (newline < 0 && textFrom + text.length < input.length) {
      const readFrom = textFrom + text.length;
      const readTo = Math.min(input.length, readFrom + window);
      text = text.slice(lineFrom - textFrom) + input.read(readFrom, readTo);
      textFrom = lineFrom;
      window *= 2;
      newline = text.indexOf("\n");
    }

    if (newline < 0) {
      yield { from: lineFrom, text: text.slice(lineFrom - textFrom) };
      return;
    }
    yield { from: lineFrom, text: text.slice(lineFrom - textFrom, newline) };
    lineFrom = textFrom + newline + 1;
  }
}
