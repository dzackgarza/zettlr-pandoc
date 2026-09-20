/**
 * Pandoc TeX-math grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Parsing/Math.hs `mathInlineWith`, `mathDisplayWith`,
 * `mathInline`, and `mathDisplay`; Markdown integration is
 * src/Text/Pandoc/Readers/Markdown.hs `math` (line 1669).
 *
 * The fork emits the existing Lezer CodeMark/CodeText containers so editor
 * consumers remain source-compatible. Recognition, however, follows Pandoc;
 * presentation/language mounting is not part of the grammar.
 */

import type { Input } from '@lezer/common'
import type { BlockContext, BlockParser, InlineParser, Line } from '../markdown'

interface BlockContextInput {
  /** @lezer/markdown exposes this at runtime but marks it internal in the d.ts. */
  input: Input
}

function blockInput (ctx: BlockContext): Input {
  return (ctx as unknown as BlockContextInput).input
}

function isSpaceChar (value: string): boolean {
  return /\s/u.test(value)
}

function skipBalancedTextCommand (text: string, from: number): number {
  if (!text.startsWith('\\text{', from)) return from
  let depth = 1
  let cursor = from + 6
  let escaped = false
  while (cursor < text.length && depth > 0) {
    const ch = text[cursor]
    if (escaped) {
      escaped = false
      cursor++
      continue
    }
    if (ch === '\\') {
      escaped = true
      cursor++
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') depth--
    cursor++
  }
  return depth === 0 ? cursor : from
}

function inlineMathEnd (text: string, from: number, open: '$'|'\\(', close: '$'|'\\)'): number {
  const contentFrom = from + open.length
  if (open === '$' && (contentFrom >= text.length || isSpaceChar(text[contentFrom]))) return -1
  let cursor = contentFrom
  let sawContent = false
  while (cursor < text.length) {
    if (text.startsWith(close, cursor)) {
      if (!sawContent) return -1
      const before = text[cursor - 1] ?? ''
      const after = text[cursor + close.length] ?? ''
      // Pandoc's whitespace restriction is dollar-specific. In
      // `mathInlineWith`, the whitespace-content branch is
      // `many1 spaceChar <* notFollowedBy (char '$')`, so `$x $` is rejected,
      // but `\( x \)` is valid and `trimMath` removes the surrounding spaces.
      // `notFollowedBy digit` applies after either closing delimiter.
      const dollarTrailingSpace = open === '$' && isSpaceChar(before)
      if (!dollarTrailingSpace && !/[0-9]/u.test(after)) return cursor + close.length
    }
    if (text[cursor] === '\\') {
      const afterText = skipBalancedTextCommand(text, cursor)
      if (afterText !== cursor) {
        sawContent = true
        cursor = afterText
        continue
      }
      if (cursor + 1 < text.length) {
        sawContent = true
        cursor += 2
        continue
      }
    }
    if (text[cursor] === '\n' && text[cursor + 1] === '\n') return -1
    if (!isSpaceChar(text[cursor])) sawContent = true
    cursor++
  }
  return -1
}

function displayMathEnd (text: string, from: number, open: '$$'|'\\[', close: '$$'|'\\]'): number {
  const contentFrom = from + open.length
  let cursor = contentFrom
  let sawContent = false
  while (cursor < text.length) {
    if (text.startsWith(close, cursor)) {
      return sawContent ? cursor + close.length : -1
    }
    if (text[cursor] === '\n' && text[cursor + 1] === '\n') return -1
    sawContent = true
    cursor++
  }
  return -1
}

function mathElement (
  ctx: Parameters<InlineParser['parse']>[0],
  from: number,
  to: number,
  openLength: number,
  closeLength: number,
) {
  const contentFrom = from + openLength
  const contentTo = to - closeLength
  return ctx.elt('InlineCode', from, to, [
    ctx.elt('CodeMark', from, contentFrom),
    ctx.elt('CodeText', contentFrom, contentTo),
    ctx.elt('CodeMark', contentTo, to),
  ])
}

export const inlineMathParser: InlineParser = {
  name: 'pandoc-tex-math-dollars',
  before: 'Escape',
  parse: (ctx, next, pos) => {
    if (next !== 36) return -1
    const relative = pos - ctx.offset
    const display = ctx.text.startsWith('$$', relative)
    const open = display ? '$$' : '$'
    const close = open
    const localEnd = display
      ? displayMathEnd(ctx.text, relative, open, close)
      : inlineMathEnd(ctx.text, relative, open, close)
    if (localEnd < 0) return -1
    const to = ctx.offset + localEnd
    return ctx.addElement(mathElement(ctx, pos, to, open.length, close.length))
  }
}

export const singleBackslashMathParser: InlineParser = {
  name: 'pandoc-tex-math-single-backslash',
  before: 'Escape',
  parse: (ctx, next, pos) => {
    if (next !== 92) return -1
    const relative = pos - ctx.offset
    const second = ctx.text[relative + 1]
    if (second !== '(' && second !== '[') return -1
    const open = second === '(' ? '\\(' : '\\['
    const close = second === '(' ? '\\)' : '\\]'
    const localEnd = second === '('
      ? inlineMathEnd(ctx.text, relative, open, close)
      : displayMathEnd(ctx.text, relative, open, close)
    if (localEnd < 0) return -1
    const to = ctx.offset + localEnd
    return ctx.addElement(mathElement(ctx, pos, to, open.length, close.length))
  }
}

const DOLLAR_DISPLAY_LINE = /^(\s*\$\$)\s*$/u
const BRACKET_DISPLAY_LINE = /^\s*\\\[\s*$/u
const BLANK_LINE = /^\s*$/u

/**
 * Non-mutating lookahead for the editor's block-shaped representation of a
 * standalone Pandoc display-math expression. Pandoc's reference parser is
 * `mathDisplayWith` in Text/Pandoc/Parsing/Math.hs: a display expression may
 * cross ordinary newlines but not a blank line and must have its closing
 * delimiter. Lezer BlockParser.parse has no rollback after `nextLine()`, so we
 * must establish the close before moving BlockContext at all.
 */
function hasDisplayBlockClose (ctx: BlockContext, line: Line, dollar: boolean): boolean {
  const input = blockInput(ctx)
  const afterOpening = ctx.lineStart + line.text.length + 1
  const remaining = input.read(afterOpening, input.length)
  for (const physicalLine of remaining.split('\n')) {
    if (BLANK_LINE.test(physicalLine)) return false
    if (dollar) {
      if (DOLLAR_DISPLAY_LINE.test(physicalLine)) return true
    } else if (physicalLine.includes('\\]')) {
      return true
    }
  }
  return false
}

export const blockMathParser: BlockParser = {
  name: 'pandoc-display-math-block',
  parse: (ctx, line) => {
    const dollar = DOLLAR_DISPLAY_LINE.test(line.text)
    const bracket = !dollar && BRACKET_DISPLAY_LINE.test(line.text)
    if (!dollar && !bracket) return false
    if (!hasDisplayBlockClose(ctx, line, dollar)) return false

    const blockStart = ctx.lineStart
    const contentFrom = ctx.lineStart + line.text.length + 1
    let closeFrom = -1
    let closeTo = -1
    let contentTo = -1

    while (ctx.nextLine()) {
      if (BLANK_LINE.test(line.text)) return false
      if (dollar && DOLLAR_DISPLAY_LINE.test(line.text)) {
        closeFrom = ctx.lineStart
        closeTo = ctx.lineStart + line.text.length
        contentTo = ctx.prevLineEnd()
        break
      }
      if (bracket) {
        const at = line.text.indexOf('\\]')
        if (at >= 0) {
          closeFrom = ctx.lineStart + at
          closeTo = closeFrom + 2
          contentTo = closeFrom
          break
        }
      }
    }
    if (closeFrom < 0) return false

    ctx.addElement(ctx.elt('FencedCode', blockStart, closeTo, [
      ctx.elt('CodeMark', blockStart, contentFrom - 1),
      ctx.elt('CodeText', contentFrom, contentTo),
      ctx.elt('CodeMark', closeFrom, closeTo),
    ]))
    ctx.nextLine()
    return true
  }
}
