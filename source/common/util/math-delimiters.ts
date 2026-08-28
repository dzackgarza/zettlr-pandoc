/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Pure math-delimiter helpers shared by the editor math parser,
 *                  the editor math renderer, and the Markdown->HTML converter.
 *
 *                  This module deliberately imports NOTHING (no CodeMirror, no
 *                  lezer): markdown-to-html runs in the main process, and pulling
 *                  the editor's CodeMirror/lezer graph into that Node bundle
 *                  breaks the webpack build. Keep it dependency-free.
 *
 * END HEADER
 */

/**
 * A math delimiter pair the editor understands. `open`/`close` are the literal
 * source delimiters.
 */
export interface MathDelimiterPair {
  open: string;
  close: string;
  display: boolean;
}

/**
 * Every math delimiter pair, most specific first so `$$` is tried before `$`.
 */
export const MATH_DELIMITERS: MathDelimiterPair[] = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
  { open: "$", close: "$", display: false },
];

/**
 * Given an opening delimiter string, returns whether it opens display math, or
 * null if it is not a recognized math delimiter.
 */
export function mathDisplayForOpen(open: string): boolean | null {
  const pair = MATH_DELIMITERS.find((d) => d.open === open);
  return pair === undefined ? null : pair.display;
}

/**
 * Strips a recognized delimiter pair off fully-delimited math text (e.g. `$$x$$`,
 * `\[x\]`, `\(x\)`, `$x$`), returning the display mode and inner equation, or
 * null if the text is not delimited math. Tolerates a single trailing newline
 * (block math nodes can carry one).
 */
export function stripMathDelimiters(text: string): { display: boolean; equation: string } | null {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (const { open, close, display } of MATH_DELIMITERS) {
    if (
      trimmed.length >= open.length + close.length &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      return { display, equation: trimmed.slice(open.length, trimmed.length - close.length) };
    }
  }
  return null;
}
