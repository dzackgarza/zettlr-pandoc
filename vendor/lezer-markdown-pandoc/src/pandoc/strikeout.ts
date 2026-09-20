/**
 * Pandoc strikeout grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * Text/Pandoc/Readers/Markdown.hs `strikeout`, `strikeStart`, `strikeEnd`,
 * and `inlinesBetween` (around lines 1750-1765).
 */

import type { InlineParser } from '../markdown'

function codeSpanEnd (text: string, from: number): number {
  if (text[from] !== '`') return from
  let width = 1
  while (text[from + width] === '`') width++
  const mark = '`'.repeat(width)
  const end = text.indexOf(mark, from + width)
  return end < 0 ? from : end + width
}

function mathEnd (text: string, from: number): number {
  let close: string | undefined
  let cursor = from
  if (text.startsWith('$$', from)) {
    close = '$$'
    cursor += 2
  } else if (text[from] === '$') {
    close = '$'
    cursor++
  } else if (text.startsWith('\\(', from)) {
    close = '\\)'
    cursor += 2
  } else if (text.startsWith('\\[', from)) {
    close = '\\]'
    cursor += 2
  }
  if (close === undefined) return from
  while (cursor < text.length) {
    if (text.startsWith(close, cursor)) return cursor + close.length
    if (text[cursor] === '\\') cursor++
    cursor++
  }
  return from
}

function strikeEnd (text: string, from: number): number {
  for (let cursor = from; cursor < text.length;) {
    if (text.startsWith('~~', cursor)) return cursor
    if (text[cursor] === '\\') {
      cursor += Math.min(2, text.length - cursor)
      continue
    }
    const codeEnd = codeSpanEnd(text, cursor)
    if (codeEnd !== cursor) {
      cursor = codeEnd
      continue
    }
    const equationEnd = mathEnd(text, cursor)
    if (equationEnd !== cursor) {
      cursor = equationEnd
      continue
    }
    cursor++
  }
  return -1
}

export const pandocStrikeoutParser: InlineParser = {
  name: 'pandoc-strikeout',
  before: 'Emphasis',
  parse: (ctx, next, pos) => {
    if (next !== 126 || ctx.char(pos + 1) !== 126 || ctx.char(pos + 2) === 126) return -1
    const contentFrom = pos + 2
    const first = ctx.char(contentFrom)
    if (first < 0 || /\s/u.test(String.fromCodePoint(first))) return -1

    const localFrom = contentFrom - ctx.offset
    const localClose = strikeEnd(ctx.text, localFrom)
    if (localClose < 0 || localClose === localFrom) return -1
    const closeFrom = ctx.offset + localClose
    const to = closeFrom + 2
    return ctx.addElement(ctx.elt('Strikethrough', pos, to, [
      ctx.elt('StrikethroughMark', pos, contentFrom),
      ...ctx.parser.parseInline(ctx.text.slice(localFrom, localClose), contentFrom),
      ctx.elt('StrikethroughMark', closeFrom, to),
    ]))
  },
}
