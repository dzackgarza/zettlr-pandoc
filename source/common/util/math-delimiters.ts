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

/**
 * The LaTeX environments Pandoc converts to display math rather than passing
 * through as raw TeX. Read off the binary (every entry renders as
 * `class="math display"` in `pandoc -t html --mathjax`), not recalled: an
 * environment the editor drew as math but Pandoc exported as raw TeX — or the
 * reverse — would be a preview that lies about the document.
 *
 * MathJax needs the `\begin`/`\end` themselves, since the environment is what
 * sets up the alignment, so an environment's equation text keeps them.
 */
export const MATH_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'equation', 'equation*',
  'align', 'align*',
  'alignat', 'alignat*',
  'aligned', 'split',
  'gather', 'gather*', 'gathered',
  'multline', 'multline*',
  'eqnarray', 'eqnarray*',
  'cases', 'array', 'subarray',
  'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'smallmatrix',
  'CD'
])

const ENVIRONMENT_OPEN_RE = /^\\begin\{([A-Za-z]+\*?)\}/

/**
 * The math environment this text opens with, or null when it opens with
 * something else — ordinary prose, a non-math environment like `center`, or a
 * delimiter.
 */
export function mathEnvironmentName (text: string): string|null {
  const match = ENVIRONMENT_OPEN_RE.exec(text)
  if (match === null) {
    return null
  }
  return MATH_ENVIRONMENTS.has(match[1]) ? match[1] : null
}

/**
 * The LaTeX environment name if `text` (ignoring trailing whitespace) is
 * exactly one `\begin{name}…\end{name}` block, or null otherwise. Agnostic of
 * which environment it is — this is the "is this whole text one LaTeX
 * environment" predicate shared by the environment linter
 * (latex-environment-lint.ts) and the TikZ raw-block renderer
 * (render-tikz.ts), each of which narrows the returned name to its own set
 * (MATH_ENVIRONMENTS, FIGURE_ENVIRONMENTS).
 */
export function wholeEnvironment (text: string): string|null {
  const match = ENVIRONMENT_OPEN_RE.exec(text)
  if (match === null) {
    return null
  }
  return text.trimEnd().endsWith(`\\end{${match[1]}}`) ? match[1] : null
}

/**
 * The math a code node carries, from the parts the Markdown AST keeps: the
 * opening mark and the source between the marks. Returns null for a genuine
 * code span.
 *
 * An environment's marks are its `\begin` and `\end`, which the source between
 * them therefore excludes — so they are put back here. Without them MathJax
 * receives bare alignment rows and reports an error.
 */
export function mathFromCodeNode (info: string, source: string): { display: boolean, equation: string }|null {
  const display = mathDisplayForOpen(info)
  if (display !== null) {
    return { display, equation: source }
  }
  const environment = mathEnvironmentName(info)
  if (environment === null) {
    return null
  }
  return { display: true, equation: `${info}${source}\\end{${environment}}` }
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
  // A math environment is its own delimiter, and keeps it: `align` without its
  // `\begin`/`\end` is not an alignment, just rows of `&`.
  const environment = wholeEnvironment(trimmed)
  if (environment !== null && MATH_ENVIRONMENTS.has(environment)) {
    return { display: true, equation: trimmed }
  }
  return null
}
