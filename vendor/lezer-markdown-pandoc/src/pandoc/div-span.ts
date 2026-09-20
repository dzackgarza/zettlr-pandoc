/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `divFenced` (line 2169),
 * `divFenceEnd`, and `bracketedSpan` (line 1916).
 */

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc Span and Div Parser
 * CVM-Role:        InlineParser, BlockParser
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     This module provides an inline and a block parser for pandoc
 *                  bracketed spans and fenced divs
 *
 * END HEADER
 */

import type { InlineParser, BlockParser, BlockContext, Line, DelimiterType } from '../markdown'
import type { Input } from '@lezer/common'
import { scanPandocAttributeList, scanPandocFencedDivOpening, type PandocFencedDivOpeningScan } from './attribute-syntax'

const pandocDivClosingRe = /^(?<mark>:{3,})\s*$/d
const PandocSpanDelimiter: DelimiterType = { consumeWithLink: true }


interface BlockContextInput {
  /** @lezer/markdown exposes this at runtime but marks it internal in the d.ts. */
  input: Input
}

function blockInput (ctx: BlockContext): Input {
  return (ctx as unknown as BlockContextInput).input
}

function readPhysicalLine (input: Input, start: number): { text: string, next: number, eof: boolean } {
  let cursor = start
  let text = ''
  while (cursor < input.length) {
    const chunk = input.chunk(cursor)
    if (chunk.length === 0) {
      break
    }
    const newline = chunk.indexOf('\n')
    if (newline !== -1) {
      text += chunk.slice(0, newline + 1)
      return { text, next: cursor + newline + 1, eof: false }
    }
    text += chunk
    cursor += chunk.length
  }
  return { text, next: cursor, eof: true }
}

/**
 * Read only as many physical lines as the Pandoc attribute scanner asks for.
 * No BlockContext state moves until a complete, valid opening has been found.
 */
function scanDivOpening (ctx: BlockContext): PandocFencedDivOpeningScan|undefined {
  const input = blockInput(ctx)
  let cursor = ctx.parsedPos
  let source = ''
  while (true) {
    const line = readPhysicalLine(input, cursor)
    source += line.text
    const scanned = scanPandocFencedDivOpening(source, line.eof)
    if (scanned.status === 'match') {
      return scanned.value
    }
    if (scanned.status === 'no-match' || line.eof) {
      return undefined
    }
    cursor = line.next
  }
}


export const pandocSpanParser: InlineParser = {
  name: 'pandoc-span',
  before: 'Link',
  parse: (ctx, next, pos) => {
    if (next === 91) { // 91 === '['
      // Keep a span-specific bracket stack. The fork's standard link resolver
      // consumes the companion delimiter at this exact source position when
      // this bracket becomes a real link, preventing nested links from leaving
      // stale span openers without invalidating an outer span opener.
      ctx.addDelimiter(PandocSpanDelimiter, pos, pos + 1, true, false)
      return -1
    }

    if (next !== 93) { // 93 === ']'
      return -1
    }

    const localAttrFrom = pos - ctx.offset + 1
    const scanned = scanPandocAttributeList(ctx.text, localAttrFrom)
    if (scanned.status !== 'match') {
      return -1
    }

    const opening = ctx.findOpeningDelimiter(PandocSpanDelimiter)
    if (opening === null) {
      return -1
    }

    const delim = ctx.getDelimiterAt(opening)
    if (delim === null) {
      return -1
    }

    const attrFrom = ctx.offset + scanned.value.from
    const attrTo = ctx.offset + scanned.value.to
    const attr = ctx.elt('PandocAttribute', attrFrom, attrTo, [
      ctx.elt('PandocAttributeMark', attrFrom, attrFrom + 1),
      ctx.elt('PandocAttributeMark', attrTo - 1, attrTo),
    ])

    const innerElements = ctx.takeContent(opening)

    const openingMark = ctx.elt('PandocSpanMark', delim.from, delim.to)
    const closingMark = ctx.elt('PandocSpanMark', pos, pos + 1)
    return ctx.addElement(ctx.elt('PandocSpan', delim.from, attrTo, [ openingMark, ...innerElements, closingMark, attr ]))
  }
}

/**
 * Helper function to determine the number of parent PandocDivs
 */
function getNestingLevel (ctx: BlockContext): number {
  let depth = 1
  for (let n = ctx.depth - 1; n >= 0; n--) {
    if (ctx.parentType(n).is('PandocDiv')) {
      depth++
    }
  }

  return depth
}

export const pandocDivParser: BlockParser = {
  name: 'pandoc-div',
  parse: (ctx, line) => {
    if (line.pos > 0) {
      return false
    }

    const opening = scanDivOpening(ctx)
    if (opening === undefined) {
      return false
    }

    const openingLineStart = ctx.lineStart
    const nestingValue = getNestingLevel(ctx) + 1

    // The opening attribute list may span physical lines. It has already been
    // recognized without moving the block parser, so advancing now is a commit,
    // not speculative parsing.
    for (let lineNumber = 1; lineNumber < opening.headerLineCount; lineNumber++) {
      if (!ctx.nextLine()) {
        return false // Defensive: a matched scan cannot normally reach this.
      }
    }

    // startComposite computes its start relative to the CURRENT physical line.
    // A negative offset is therefore exactly what preserves the original fence
    // position after a multiline opening header has been consumed.
    ctx.startComposite('PandocDiv', openingLineStart - ctx.lineStart, nestingValue)

    const absolute = (relative: number): number => openingLineStart + relative
    ctx.addElement(ctx.elt(
      'PandocDivMark',
      absolute(opening.markFrom),
      absolute(opening.markTo),
    ))

    if (opening.bareClass !== undefined) {
      ctx.addElement(ctx.elt(
        'PandocDivInfo',
        absolute(opening.bareClass.from),
        absolute(opening.bareClass.to),
      ))
    }

    if (opening.attribute !== undefined) {
      const from = absolute(opening.attribute.from)
      const to = absolute(opening.attribute.to)
      ctx.addElement(ctx.elt('PandocAttribute', from, to, [
        ctx.elt('PandocAttributeMark', from, from + 1),
        ctx.elt('PandocAttributeMark', to - 1, to),
      ]))
    }

    // Nothing after the completed opening syntax is body content. Move the
    // current physical line to its end; normal composite parsing resumes on the
    // following line.
    line.moveBase(line.text.length)
    return null
  },

  endLeaf: (ctx, line, _leaf) => {
    if (ctx.parentType().name === 'PandocDiv') {
      return pandocDivClosingRe.test(line.text)
    }
    // Pandoc's paragraph `endline` only tests `notFollowedByDivCloser` while
    // already inside a fenced div. At top level, and for nested div OPENERS,
    // `:::` is ordinary paragraph text unless a blank line ended the leaf.
    return false
  },
}

// This function is used in the node [composite](https://github.com/lezer-parser/markdown?tab=readme-ov-file#user-content-nodespec.composite) method:
//
// If this is a composite block, this should hold a function that,
// at the start of a new line where that block is active, checks
// whether the composite block should continue (return value) and
// optionally adjusts the line's base position and registers nodes
// for any markers involved in the block's syntax.
export function pandocDivComposite (ctx: BlockContext, line: Line, value: number): boolean {

  // Pandoc's `divFenced` asks for a closing fence only between parsed blocks.
  // A `:::` line inside fenced/indented code or another opaque child block is
  // therefore ordinary child-block content, not a div close. Lezer composite
  // continuation runs before the child block parser, so the base fork exposes
  // this explicit opaque-block signal to preserve Pandoc's ordering.
  if (ctx.inOpaqueBlock) {
    return true
  }

  // We only want to end the block if the nesting level, `value`,
  // matches the number of parent PandocDivs so that other parent
  // blocks are not ended early.
  if (value !== getNestingLevel(ctx)) {
    return true
  }

  const match = pandocDivClosingRe.exec(line.text)
  if (!match?.indices?.groups) {
    return true
  }

  const [ markFrom, markTo ] = match.indices.groups.mark
  const from = ctx.lineStart + markFrom
  const to = ctx.lineStart + markTo

  // Add the closing marker and move the line position
  // up so that we do not re-parse the text.
  line.addMarker(ctx.elt('PandocDivMark', from, to))
  line.moveBase(to)

  return false
}
