/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        formatDocument editor command (issue #26)
 * CVM-Role:        Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The editor-side half of the flowmark "Format document"
 *                  command. Given an injected formatter (the production one
 *                  routes through the main-process flowmark service over IPC),
 *                  it replaces the whole buffer with the formatted text as a
 *                  SINGLE undo step and preserves the caret across flowmark's
 *                  whitespace-only reflow. A typed formatter failure leaves the
 *                  buffer byte-identical and is returned to the caller rather
 *                  than swallowed, so absence of the external tool is loud.
 *
 * END HEADER
 */

import { EditorSelection } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'

/**
 * The typed outcome of a format attempt. `ok: false` is a real domain state
 * (the external tool was missing, or reported an error) — never a silent no-op.
 */
export type FormatResult =
  | { ok: true, formatted: string }
  | { ok: false, kind: 'flowmark-absent' | 'flowmark-error' | 'flowmark-timeout', message: string }

/** Formats markdown source text, returning a typed result. */
export type MarkdownFormatter = (text: string) => Promise<FormatResult>

function isWhitespace (char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v'
}

/** Counts the non-whitespace characters in `text` strictly before `pos`. */
function nonWhitespaceBefore (text: string, pos: number): number {
  let count = 0
  for (let i = 0; i < pos && i < text.length; i++) {
    if (!isWhitespace(text[i])) {
      count++
    }
  }
  return count
}

/** Returns the index of the `n`-th (1-based) non-whitespace char, or -1. */
function indexOfNthNonWhitespace (text: string, n: number): number {
  if (n <= 0) {
    return -1
  }
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (!isWhitespace(text[i])) {
      count++
      if (count === n) {
        return i
      }
    }
  }
  return -1
}

/**
 * Maps a caret offset from `original` onto `formatted`, anchoring it to the
 * same non-whitespace character it was adjacent to. flowmark's `--semantic`
 * reflow only rewrites whitespace/line breaks, so the ordered sequence of
 * non-whitespace characters is stable — mapping by that index survives the
 * reflow where a raw byte offset would drift.
 */
export function mapCaretThroughReflow (original: string, formatted: string, caret: number): number {
  const before = nonWhitespaceBefore(original, caret)
  const caretOnWord = caret < original.length && !isWhitespace(original[caret])

  if (caretOnWord || caret === 0) {
    // Caret sits at the start of a word (or the document start): land it just
    // before the next non-whitespace character in the formatted text.
    const idx = indexOfNthNonWhitespace(formatted, before + 1)
    return idx === -1 ? formatted.length : idx
  }

  // Caret trails a word (whitespace or end-of-doc ahead): land it just after
  // the same non-whitespace character it followed.
  const idx = indexOfNthNonWhitespace(formatted, before)
  return idx === -1 ? 0 : idx + 1
}

/**
 * Runs the injected formatter over the current buffer and applies the result
 * as a single, caret-preserving undo step.
 *
 * - On a typed failure the buffer is left untouched and the result returned.
 * - When the formatted text equals the buffer, no transaction is dispatched, so
 *   a no-op format never pollutes the undo history.
 *
 * @param   view    The target EditorView.
 * @param   format  The formatter (production: the flowmark service over IPC).
 *
 * @return          The formatter's typed result.
 */
export async function formatDocument (view: EditorView, format: MarkdownFormatter): Promise<FormatResult> {
  const original = view.state.doc.toString()
  const result = await format(original)

  if (!result.ok) {
    return result
  }

  if (result.formatted === original) {
    return result
  }

  const caret = view.state.selection.main.head
  const mapped = mapCaretThroughReflow(original, result.formatted, caret)

  view.dispatch({
    changes: { from: 0, to: original.length, insert: result.formatted },
    selection: EditorSelection.single(mapped)
  })

  return result
}
