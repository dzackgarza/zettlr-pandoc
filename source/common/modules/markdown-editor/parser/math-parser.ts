/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Math Parser
 * CVM-Role:        InlineParser, BlockParser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module provides inline and block parsers for math. It
 *                  recognizes both the dollar delimiters ($ inline, $$ display)
 *                  and the LaTeX delimiters (\( \) inline, \[ \] display).
 *
 *                  The LaTeX-delimiter matching mirrors markdown-it-texmath's
 *                  "brackets" flavor (github.com/goessner/markdown-it-texmath):
 *                  inline \( ... \), display \[ ... \]; the closing \] may sit at
 *                  the end of a content line (e.g. a trailing sentence period,
 *                  ".\]"), not only on its own line.
 *
 * END HEADER
 */

import type { DelimiterType, InlineParser, BlockParser } from '@lezer/markdown'
import { StreamLanguage } from '@codemirror/language'
import { stexMath } from '@codemirror/legacy-modes/mode/stex'

const stexLang = StreamLanguage.define(stexMath)

const MathDelimiter: DelimiterType = {}

// A line that is only `$$` (opens or closes a dollar display block).
const blockMathRE = /^(\s*\$\$)\s*$/
// A line that is only `\[` (opens a bracket display block).
const bracketOpenRE = /^\s*\\\[\s*$/
const blankLineRe = /^\s*$/

export const inlineMathParser: InlineParser = {
  // This parser should only match inline-math (we have to divide that here)
  name: 'inlineMath',
  parse: (ctx, next, pos) => {
    if (next !== 36) { // 36 === '$'
      return -1
    }

    // Even though double dollars mark a display equation, it is perfectly
    // within spec to keep it inline (it will be rendered as a block element).
    // Since this technically (from the parser's perspective) makes this an
    // inline-element, we implement this check here, and not in the block parser
    // below.
    const isInlineDisplayMath = ctx.char(pos + 1) === 36
    const delimLength = isInlineDisplayMath ? 2 : 1

    // Try to find an opening delimiter
    const opening = ctx.findOpeningDelimiter(MathDelimiter)

    // Since there was no opening delimiter, this is a potential opening
    if (opening === null) {
      // Inline opening delimiters cannot be followed by a space, but display math delimiters can
      const invalidOpening = !isInlineDisplayMath && /\s/.test(ctx.slice(pos + 1, pos + 2))

      // Either return -1 due to an invalid delimiter, or return the end position of the delimiter
      return  invalidOpening ? -1 : ctx.addDelimiter(MathDelimiter, pos, pos + delimLength, true, false)
    }

    const delim = ctx.getDelimiterAt(opening)
    if (delim === null) {
      return -1
    }

    // Ensure the opening and closing delimiters are the same length
    if (delim.to - delim.from !== delimLength) {
      return -1
    }

    // Inline closing delimiters cannot be preceded by a space or followed by a digit, but display math delimiters can
    if (!isInlineDisplayMath && (/\s/.test(ctx.slice(pos - 1, pos)) || /\d/.test(ctx.slice(pos + 1, pos + 2)))) {
      // However, if this is an invalid closing delimiter, we need to check if
      // it would be a valid  opening delimiter and add it to the tree if it is.
      const invalidOpening = /\s/.test(ctx.slice(pos + 1, pos + 2))

      // Either return -1 due to an invalid delimiter, or return the end position of the delimiter
      return  invalidOpening ? -1 : ctx.addDelimiter(MathDelimiter, pos, pos + delimLength, true, false)
    }

    // Remove any elements that were parsed internally
    ctx.takeContent(opening)

    ctx.addDelimiter(MathDelimiter, pos, pos + delimLength, false, true)

    const contents = ctx.slice(delim.to, pos)
    // Parse the interior content using stex
    const innerElements = ctx.elt(stexLang.parser.parse(contents), delim.to)

    const openingMark = ctx.elt('CodeMark', delim.from, delim.to)
    const closingMark = ctx.elt('CodeMark', pos, pos + delimLength)

    return ctx.addElement(ctx.elt('InlineCode', delim.from, pos + delimLength, [ openingMark, innerElements, closingMark ]))
  }
}

/**
 * Inline parser for the LaTeX delimiters `\( ... \)` (inline) and `\[ ... \]`
 * (display). The dollar parser above cannot handle these because their opening
 * and closing delimiters differ, so this is a direct scan (mirroring
 * markdown-it-texmath's `/\\\((.+?)\\\)/` and `/\\\[([\s\S]+?)\\\]/`). Running as
 * an inline parser lets `\[ ... \]` be recognized even when it follows prose on
 * the previous line (mid-paragraph), which the block parser cannot catch.
 */
export const inlineBracketMathParser: InlineParser = {
  name: 'inlineBracketMath',
  // Must run before the built-in Escape rule, which would otherwise consume the
  // `\(` / `\[` opener as an escaped character before we ever see it.
  before: 'Escape',
  parse: (ctx, next, pos) => {
    if (next !== 92) { // 92 === '\'
      return -1
    }
    const second = ctx.char(pos + 1)
    // 40 === '(' -> inline \( \); 91 === '[' -> display \[ \]
    const closeDelim = second === 40 ? '\\)' : second === 91 ? '\\]' : null
    if (closeDelim === null) {
      return -1
    }

    const rest = ctx.slice(pos + 2, ctx.end)
    const closeOffset = rest.indexOf(closeDelim)
    if (closeOffset === -1) {
      return -1
    }

    const contentFrom = pos + 2
    const contentTo = pos + 2 + closeOffset
    const closeTo = contentTo + 2

    const innerElements = ctx.elt(stexLang.parser.parse(ctx.slice(contentFrom, contentTo)), contentFrom)
    const openingMark = ctx.elt('CodeMark', pos, contentFrom)
    const closingMark = ctx.elt('CodeMark', contentTo, closeTo)

    return ctx.addElement(ctx.elt('InlineCode', pos, closeTo, [ openingMark, innerElements, closingMark ]))
  }
}

export const blockMathParser: BlockParser = {
  name: 'blockMath',
  parse: (ctx, line) => {
    const isDollar = blockMathRE.test(line.text)
    const isBracket = !isDollar && bracketOpenRE.test(line.text)
    if (!isDollar && !isBracket) {
      return false
    }

    const equationLines: string[] = []

    const blockStart = ctx.lineStart
    const from = ctx.lineStart + line.text.length + 1

    let closeMarkFrom = -1
    let closeMarkTo = -1
    let contentEnd = -1
    let closed = false

    while (ctx.nextLine()) {
      if (blankLineRe.test(line.text)) {
        break // A blank line aborts the block (it never closed).
      }

      if (isDollar) {
        if (blockMathRE.test(line.text)) {
          closeMarkFrom = ctx.lineStart
          closeMarkTo = ctx.lineStart + line.text.length
          contentEnd = ctx.prevLineEnd()
          closed = true
          break
        }
        equationLines.push(line.text)
      } else {
        // Bracket display: close on `\]`, which may follow content on the same
        // line (e.g. a trailing ".\]").
        const idx = line.text.indexOf('\\]')
        if (idx !== -1) {
          if (idx > 0) {
            equationLines.push(line.text.slice(0, idx))
          }
          closeMarkFrom = ctx.lineStart + idx
          closeMarkTo = closeMarkFrom + 2
          contentEnd = closeMarkFrom
          closed = true
          break
        }
        equationLines.push(line.text)
      }
    }

    if (!closed) {
      // The parser collected the rest of the document without finding a closing
      // delimiter. Abort to keep the document readable.
      return false
    }

    // Parse the interior content using stex
    const innerElements = ctx.elt(stexLang.parser.parse(equationLines.join('\n')), from)
    const codeText = ctx.elt('CodeText', from, contentEnd, [ innerElements ])

    const openingMark = ctx.elt('CodeMark', blockStart, from - 1)
    const closingMark = ctx.elt('CodeMark', closeMarkFrom, closeMarkTo)

    ctx.addElement(ctx.elt('FencedCode', blockStart, closeMarkTo, [ openingMark, codeText, closingMark ]))
    ctx.nextLine()

    return true
  }
}
