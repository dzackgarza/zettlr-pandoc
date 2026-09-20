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
export interface MathDelimiterPair { open: string, close: string, display: boolean }

/**
 * Every math delimiter pair, most specific first so `$$` is tried before `$`.
 */
export const MATH_DELIMITERS: MathDelimiterPair[] = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false }
]

const ENVIRONMENT_OPEN_RE = /^\\begin\{([A-Za-z]+\*?)\}/

/**
 * The LaTeX environment name if `text` (ignoring trailing whitespace) is
 * exactly one `\begin{name}…\end{name}` block, or null otherwise. Agnostic of
 * which environment it is. This helper is used only after the Markdown AST has
 * already established a Pandoc RawBlock; it helps the TikZ renderer narrow that
 * raw TeX block to one of its supported figure environments. It is not a
 * Markdown syntax recognizer or linter.
 */
export function wholeEnvironment (text: string): string|null {
  const match = ENVIRONMENT_OPEN_RE.exec(text)
  if (match === null) {
    return null
  }
  return text.trimEnd().endsWith(`\\end{${match[1]}}`) ? match[1] : null
}

/**
 * The math a code node carries, from the parts the Markdown AST keeps. Pandoc's
 * Markdown reader recognizes only the delimiter forms here; LaTeX environments
 * are raw TeX in Markdown.
 */
export function mathFromCodeNode (info: string, source: string): { display: boolean, equation: string }|null {
  const display = mathDisplayForOpen(info)
  return display === null ? null : { display, equation: source }
}

/**
 * Given an opening delimiter string, returns whether it opens display math, or
 * null if it is not a recognized math delimiter.
 */
export function mathDisplayForOpen (open: string): boolean | null {
  const pair = MATH_DELIMITERS.find(d => d.open === open)
  return pair === undefined ? null : pair.display
}

/**
 * Strips a recognized delimiter pair off fully-delimited math text (e.g. `$$x$$`,
 * `\[x\]`, `\(x\)`, `$x$`), returning the display mode and inner equation, or
 * null if the text is not delimited math. Tolerates a single trailing newline
 * (block math nodes can carry one).
 */
export function stripMathDelimiters (text: string): { display: boolean, equation: string } | null {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  for (const { open, close, display } of MATH_DELIMITERS) {
    if (trimmed.length >= open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return { display, equation: trimmed.slice(open.length, trimmed.length - close.length) }
    }
  }
  return null
}
