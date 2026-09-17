/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        remark-latex-math
 * CVM-Role:        remark plugin
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A remark plugin that rewrites `\( … \)` and `\[ … \]`
 *                  text runs into `inlineMath` / `math` AST nodes so that
 *                  downstream lint rules (emphasis-marker, strong-marker)
 *                  do not fire on underscores inside LaTeX math.
 *
 *                  `remark-math` only recognises `$` delimiters.  This fork
 *                  uses `\( \)` and `\[ \]` throughout; without this plugin
 *                  the remark linter sees every subscript `_` as emphasis.
 *
 *                  Runs as a *tree* transform (after parsing, before linting)
 *                  rather than a micromark extension, because the lint
 *                  pipeline is a pure `remark()` chain and the goal is only
 *                  to suppress false positives — not to produce a faithful
 *                  AST for compilation.
 *
 * END HEADER
 */

import type { Root, Text, PhrasingContent } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'

/**
 * Match `\(…\)` (inline) and `\[…\]` (display) across the concatenated text
 * of sibling text nodes. The regex is non-greedy so `\(a\) b \(c\)` yields
 * two matches rather than one that spans the gap.
 */
const LATEX_INLINE_RE = /\\\([\s\S]*?\\\)/g
const LATEX_DISPLAY_RE = /\\\[[\s\S]*?\\\]/g

/**
 * remark plugin: rewrite LaTeX-delimited math in text nodes into mdast
 * `inlineMath` / `math` nodes so lint rules treat them as opaque math.
 */
export default function remarkLatexMath (): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (index === undefined || parent === undefined) {
        return
      }

      const replaced = splitMathFromText(node.value)
      if (replaced === null) {
        return
      }

      // Splice the replacement nodes into the parent's children.
      parent.children.splice(index, 1, ...replaced)
      return [SKIP, index + replaced.length]
    })
  }
}

/**
 * Split a text value into interleaved text and math nodes. Returns null when
 * the value contains no LaTeX math delimiters (fast path — no allocation).
 */
function splitMathFromText (value: string): PhrasingContent[] | null {
  // Collect all matches with their delimiter type.
  interface MathMatch { start: number, end: number }
  const matches: MathMatch[] = []

  LATEX_INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LATEX_INLINE_RE.exec(value)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length })
  }

  LATEX_DISPLAY_RE.lastIndex = 0
  while ((m = LATEX_DISPLAY_RE.exec(value)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length })
  }

  if (matches.length === 0) {
    return null
  }

  // Sort by start position and remove overlaps (inline `\(` inside a `\[…\]`).
  matches.sort((a, b) => a.start - b.start)
  const merged: MathMatch[] = []
  for (const match of matches) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && match.start < prev.end) {
      continue // overlapping — drop the later match
    }
    merged.push(match)
  }

  const result: PhrasingContent[] = []
  let cursor = 0
  for (const match of merged) {
    if (match.start > cursor) {
      result.push({ type: 'text', value: value.slice(cursor, match.start) })
    }
    // `\(`, `\)`, `\[`, `\]` are all 2 characters.
    const delimLen = 2
    const inner = value.slice(match.start + delimLen, match.end - delimLen)
    // Both display (\[…\]) and inline (\(…\)) produce inlineMath: `math` is
    // BlockContent and cannot splice into a paragraph's children. The goal is
    // only to mark the region opaque to lint rules.
    result.push({ type: 'inlineMath', value: inner } as PhrasingContent)
    cursor = match.end
  }
  if (cursor < value.length) {
    result.push({ type: 'text', value: value.slice(cursor) })
  }
  return result
}
