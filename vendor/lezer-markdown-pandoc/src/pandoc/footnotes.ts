/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `note` (line 2076) and
 * `inlineNote` (line 2100).
 */

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Footnote Parser
 * CVM-Role:        InlineParser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This inline parser adds footnote elements to the Lezer tree.
 *
 * END HEADER
 */

import type { InlineParser, BlockParser, DelimiterType, BlockContext, Line } from '../markdown'
import { scanPandocAttributeList } from './attribute-syntax'

const FootnoteDelimiter: DelimiterType = {}

const validFootnoteRe = /^[^\s\^\[\]]+$/

// Group 1 is the label alone; the body may start after a space or on the next
// line, so the separator is a space *or* the end of the line.
const footnoteRefRe = /^(\[\^[^\s\^\[\]]+\]:)(?:\s|$)/

function codeSpanEnd (text: string, from: number): number {
  if (text[from] !== '`') return from
  let width = 1
  while (text[from + width] === '`') width++
  const mark = '`'.repeat(width)
  const end = text.indexOf(mark, from + width)
  return end < 0 ? from : end + width
}

function delimitedEnd (text: string, from: number, open: string, close: string): number {
  if (!text.startsWith(open, from)) return from
  for (let cursor = from + open.length; cursor < text.length; cursor++) {
    if (text.startsWith(close, cursor)) return cursor + close.length
    if (text[cursor] === '\\') cursor++
  }
  return from
}

/**
 * Pandoc `inlineNote` uses `inBalancedBrackets inlines`, so brackets inside
 * code/math do not participate in note balancing. This scanner is lookahead
 * only: it must not mutate InlineContext until the whole note and its trailing
 * negative-lookahead condition are known to succeed.
 */
function inlineNoteClose (text: string, from: number): number {
  if (!text.startsWith('^[', from)) return -1
  let depth = 1
  for (let cursor = from + 2; cursor < text.length;) {
    if (text[cursor] === '\\') {
      const bracketMath = delimitedEnd(text, cursor, '\\[', '\\]')
      if (bracketMath !== cursor) { cursor = bracketMath; continue }
      const parenMath = delimitedEnd(text, cursor, '\\(', '\\)')
      if (parenMath !== cursor) { cursor = parenMath; continue }
      cursor += Math.min(2, text.length - cursor)
      continue
    }
    const codeEnd = codeSpanEnd(text, cursor)
    if (codeEnd !== cursor) { cursor = codeEnd; continue }
    const displayMath = delimitedEnd(text, cursor, '$$', '$$')
    if (displayMath !== cursor) { cursor = displayMath; continue }
    const inlineMath = delimitedEnd(text, cursor, '$', '$')
    if (inlineMath !== cursor) { cursor = inlineMath; continue }
    if (text[cursor] === '[') depth++
    if (text[cursor] === ']') {
      depth--
      if (depth === 0) return cursor
    }
    cursor++
  }
  return -1
}

export const footnoteParser: InlineParser = {
  name: 'footnotes',
  before: 'Link', // [^1] will otherwise be detected as a link
  parse (ctx, next, pos) {
    if (next !== 91 && next !== 94 && next !== 93) { // 91 === '[', 94 === '^', 93 === ']'
      return -1
    }

    // Footnote Style: [^identifier]
    if (next === 91 && ctx.char(pos + 1) === 94) { // 91 === '[', 94 === '^'
      ctx.addDelimiter(FootnoteDelimiter, pos, pos + 2, true, false)

      // We return -1 here so that the link parser can add its delimiters
      // since [^invalid id](my url) is a valid link otherwise.
      return -1
    }

    // Footnote Style: ^[inline]. Pandoc wraps the entire parser in `try`, so a
    // failure must leave both `^` and `[` untouched for later alternatives.
    if (next === 94 && ctx.char(pos + 1) === 91) {
      const localFrom = pos - ctx.offset
      const close = inlineNoteClose(ctx.text, localFrom)
      if (close < 0) return -1
      const after = close + 1
      const following = ctx.text[after]
      const followedByAttributes = following === '{' &&
        scanPandocAttributeList(ctx.text, after).status === 'match'
      if (following === '(' || following === '[' || followedByAttributes) return -1

      const contentFrom = localFrom + 2
      const absoluteContentFrom = ctx.offset + contentFrom
      const absoluteClose = ctx.offset + close
      const children = ctx.parser.parseInline(
        ctx.text.slice(contentFrom, close),
        absoluteContentFrom,
      )
      return ctx.addElement(ctx.elt('Footnote', pos, absoluteClose + 1, children))
    }

    let opening = null
    if (next === 93) {  // 93 === ']'
      opening = ctx.findOpeningDelimiter(FootnoteDelimiter)
    }

    if (opening === null) { return -1}

    const delim = ctx.getDelimiterAt(opening)
    if (delim === null) { return -1 }

    // Finally, check if the identifier is valid
    if (!validFootnoteRe.test(ctx.slice(delim.to, pos))) {
      ctx.discardDelimiter(opening)
      return -1
    }

    const children = ctx.takeContent(opening)
    // `note` has higher Pandoc precedence than `bracketedSpan` and `link` for
    // `[^id]`. A successful note therefore owns the opening `[` outright.
    ctx.discardLinkCompanionDelimiters(delim.from, delim.from + 1)
    ctx.discardOpeningLinkDelimiter(delim.from, delim.from + 1)

    ctx.addDelimiter(FootnoteDelimiter, pos, pos + 1, false, true)
    return ctx.addElement(ctx.elt('Footnote', delim.from, pos + 1))
  }
}

export const footnoteRefParser: BlockParser = {
  name: 'footnote-refs',
  parse (ctx, line) {
    // This prevents footnotes from nesting into footnotes
    // and it prevents infinite recursion and OOM errors.
    if (ctx.depth > 1) { return false }

    const match = footnoteRefRe.exec(line.text)
    if (!match) { return false }

    ctx.startComposite('FootnoteRef', 0)
    ctx.addElement(ctx.elt('FootnoteRefLabel', ctx.lineStart, ctx.lineStart + match[1].length))

    line.moveBaseColumn(match[0].length)

    return null
  },

  // This is required since the composite block technically starts a `Paragraph`,
  // so in order for stacked footnotes, we have to be able to interrupt paragraph blocks.
  // But we only need to do this for paragraphs which are direct children of a `FootnoteRef`
  endLeaf (ctx, line, _leaf) {
    if (ctx.parentType().name === 'FootnoteRef') {
      return footnoteRefRe.test(line.text)
    }

    return false
  }
}

export function footnoteComposite (ctx: BlockContext, line: Line, _value: number): boolean {
  // If the line is indented, or the line is empty and the next line is indented.
  if (line.indent >= 4 || (/^\s*$/.test(line.text) && /^([ ]{4,}|\t)/.test(ctx.peekLine()))) {
    line.moveBaseColumn(4)
    return true
  }

  return false
}
