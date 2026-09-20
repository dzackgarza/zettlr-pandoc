/**
 * Pandoc pipe/grid table grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `gridTable` (line 1407), `pipeBreak`
 * (line 1426), `pipeTable` (line 1436), `pipeTableRow` (line 1467),
 * `pipeTableCell` (line 1483), `pipeTableHeaderPart` (line 1489), and
 * `scanForPipe`. Grid-table geometry ultimately delegates there to
 * Text/Pandoc/Parsing.hs `gridTableWith'`.
 *
 * Recognition tests in test/pandoc-table-differential-oracle.spec.ts use the
 * real Pandoc JSON reader as the semantic oracle.
 */

import type {
  BlockContext,
  BlockParser,
  Element,
  LeafBlock,
  LeafBlockParser,
  Line,
} from '../markdown'
import { rawLatexInlineEndAtStart } from './raw-latex-syntax'

interface PipeCellSpan {
  from: number
  to: number
}

interface PipeRowScan {
  cells: PipeCellSpan[]
  separators: number[]
  leadingPipe: boolean
  trailingPipe: boolean
}

interface PipeDelimiterScan {
  columns: number
}

function skipHorizontalSpace (text: string, from = 0): number {
  let cursor = from
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
  return cursor
}

function previousNonspace (text: string): number {
  let cursor = text.length - 1
  while (cursor >= 0 && (text[cursor] === ' ' || text[cursor] === '\t')) cursor--
  return cursor
}

function codeSpanEnd (text: string, from: number): number {
  if (text[from] !== '`') return from
  let width = 1
  while (text[from + width] === '`') width++
  const mark = '`'.repeat(width)
  const end = text.indexOf(mark, from + width)
  return end < 0 ? from : end + width
}

function delimitedMathEnd (text: string, from: number): number {
  let close: string | undefined
  let contentFrom = from
  if (text.startsWith('$$', from)) {
    close = '$$'
    contentFrom += 2
  } else if (text[from] === '$') {
    close = '$'
    contentFrom++
  } else if (text.startsWith('\\(', from)) {
    close = '\\)'
    contentFrom += 2
  } else if (text.startsWith('\\[', from)) {
    close = '\\]'
    contentFrom += 2
  }
  if (close === undefined) return from

  for (let cursor = contentFrom; cursor < text.length; cursor++) {
    if (text.startsWith(close, cursor)) return cursor + close.length
    if (text[cursor] === '\\' && !text.startsWith('\\)', cursor) && !text.startsWith('\\]', cursor)) cursor++
  }
  return from
}

function htmlInlineEnd (text: string, from: number): number {
  if (text[from] !== '<') return from
  let quote: '"'|"'"|undefined
  for (let cursor = from + 1; cursor < text.length; cursor++) {
    const char = text[cursor]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return cursor + 1
  }
  return from
}

/**
 * Find separator pipes while honoring exactly the classes of chunks Pandoc's
 * `pipeTableRow` protects from separator interpretation: code, math, raw HTML,
 * escaped characters, and raw LaTeX inline syntax.
 */
function pipeSeparators (line: string): number[] {
  const result: number[] = []
  for (let cursor = 0; cursor < line.length; cursor++) {
    const char = line[cursor]
    if (char === '\\') {
      const mathEnd = delimitedMathEnd(line, cursor)
      if (mathEnd > cursor) {
        cursor = mathEnd - 1
        continue
      }
      const rawEnd = rawLatexInlineEndAtStart(line.slice(cursor))
      if (rawEnd !== null) {
        cursor += rawEnd - 1
        continue
      }
      if (cursor + 1 < line.length) cursor++
      continue
    }
    if (char === '`') {
      const end = codeSpanEnd(line, cursor)
      if (end > cursor) {
        cursor = end - 1
        continue
      }
    }
    if (char === '$') {
      const end = delimitedMathEnd(line, cursor)
      if (end > cursor) {
        cursor = end - 1
        continue
      }
    }
    if (char === '<') {
      const end = htmlInlineEnd(line, cursor)
      if (end > cursor) {
        cursor = end - 1
        continue
      }
    }
    if (char === '|') result.push(cursor)
  }
  return result
}

/** Port of Pandoc `pipeTableRow`: split a physical row only at real pipe separators. */
function scanPipeRow (line: string): PipeRowScan | null {
  const separators = pipeSeparators(line)
  if (separators.length === 0) return null

  const contentStart = skipHorizontalSpace(line)
  const contentEnd = previousNonspace(line)
  const leadingPipe = separators[0] === contentStart
  const trailingPipe = separators[separators.length - 1] === contentEnd

  const cells: PipeCellSpan[] = []
  let from = leadingPipe ? separators[0] + 1 : contentStart
  const firstSeparator = leadingPipe ? 1 : 0
  for (let index = firstSeparator; index < separators.length; index++) {
    cells.push({ from, to: separators[index] })
    from = separators[index] + 1
  }
  if (!trailingPipe) cells.push({ from, to: line.length })

  // Pandoc admits a one-column row only when an outer pipe makes it
  // unambiguously tabular.
  if (cells.length === 1 && !leadingPipe && !trailingPipe) return null
  return { cells, separators, leadingPipe, trailingPipe }
}

/** Port of Pandoc `pipeBreak` + `pipeTableHeaderPart`. */
function scanPipeDelimiter (line: string): PipeDelimiterScan | null {
  let source = line.trim()
  const leadingPipe = source.startsWith('|')
  const trailingPipe = source.endsWith('|')
  if (leadingPipe) source = source.slice(1)
  if (trailingPipe) source = source.slice(0, -1)
  if (source.trim() === '') return null

  const parts = source.split(/[|+]/u)
  if (parts.some(part => !/^\s*:?-+:?\s*$/u.test(part))) return null
  if (parts.length === 1 && !leadingPipe && !trailingPipe) return null
  return { columns: parts.length }
}

function trimmedSpan (line: string, span: PipeCellSpan): PipeCellSpan {
  let from = span.from
  let to = span.to
  while (from < to && (line[from] === ' ' || line[from] === '\t')) from++
  while (to > from && (line[to - 1] === ' ' || line[to - 1] === '\t')) to--
  return { from, to }
}

function pipeRowElement (
  ctx: BlockContext,
  name: 'TableHeader'|'TableRow',
  line: string,
  absoluteStart: number,
): Element | null {
  const scanned = scanPipeRow(line)
  if (scanned === null) return null
  const elements: Element[] = []
  for (const separator of scanned.separators) {
    elements.push(ctx.elt('TableDelimiter', absoluteStart + separator, absoluteStart + separator + 1))
  }
  for (const rawCell of scanned.cells) {
    const cell = trimmedSpan(line, rawCell)
    if (cell.from === cell.to) continue
    elements.push(ctx.elt(
      'TableCell',
      absoluteStart + cell.from,
      absoluteStart + cell.to,
      ctx.parser.parseInline(line.slice(cell.from, cell.to), absoluteStart + cell.from),
    ))
  }
  elements.sort((a, b) => a.from - b.from || a.to - b.to)
  return ctx.elt(name, absoluteStart, absoluteStart + line.length, elements)
}

class PandocPipeTableParser implements LeafBlockParser {
  private rows: false | null | Element[] = null
  private columns = 0

  private addTable (ctx: BlockContext, leaf: LeafBlock): boolean {
    if (this.rows === false || this.rows === null) return false
    ctx.addLeafElement(
      leaf,
      ctx.elt('Table', leaf.start, leaf.start + leaf.content.length, this.rows),
    )
    this.rows = false
    return true
  }

  nextLine (ctx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    const text = line.text.slice(line.pos)
    const absoluteStart = ctx.lineStart + line.pos

    if (this.rows === null) {
      const delimiter = scanPipeDelimiter(text)
      const header = pipeRowElement(ctx, 'TableHeader', leaf.content, leaf.start)
      if (delimiter === null || header === null) {
        this.rows = false
        return false
      }
      this.columns = delimiter.columns
      this.rows = [
        header,
        ctx.elt('TableDelimiter', absoluteStart, absoluteStart + text.length),
      ]
      return false
    }

    if (this.rows === false) return false

    const row = pipeRowElement(ctx, 'TableRow', text, absoluteStart)
    if (row === null) {
      // Pandoc's `many pipeTableRow` stops before the first non-row. Finish the
      // table without consuming this line so normal block parsing sees it.
      this.addTable(ctx, leaf)
      return true
    }
    this.rows.push(row)
    return false
  }

  finish (ctx: BlockContext, leaf: LeafBlock): boolean {
    return this.addTable(ctx, leaf)
  }
}

export const pipeTableParser: BlockParser = {
  name: 'pipe-table',
  before: 'SetextHeading',
  leaf (_ctx, leaf) {
    return scanPipeRow(leaf.content) === null ? null : new PandocPipeTableParser()
  },
  endLeaf (ctx, line, leaf) {
    if (leaf.parsers.some(parser => parser instanceof PandocPipeTableParser)) return false
    const current = line.text.slice(line.basePos)
    if (scanPipeRow(current) === null) return false
    return scanPipeDelimiter(ctx.peekLine()) !== null
  },
}

// Grid tables use fixed column boundaries rather than inline pipe splitting.
// The Lezer tree preserves physical row/cell spans for the editor; Pandoc's
// JSON oracle verifies recognition, header-vs-body classification, and column
// count for the supported geometry.
const GRID_BORDER = /^\s*\+(?:(?:-+|=+)\+)+\s*$/u
const GRID_CONTENT = /^\s*\|.*\|\s*$/u

function gridBoundaries (line: string): number[] {
  const result: number[] = []
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '+') result.push(index)
  }
  return result
}

function sameGridGeometry (line: string, boundaries: readonly number[]): boolean {
  const positions: number[] = []
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '+' || line[index] === '|') positions.push(index)
  }
  return positions.length === boundaries.length && positions.every((value, index) => value === boundaries[index])
}

function gridCells (
  ctx: BlockContext,
  line: string,
  absoluteStart: number,
  boundaries: readonly number[],
): Element[] {
  const result: Element[] = []
  for (let column = 0; column + 1 < boundaries.length; column++) {
    const raw = { from: boundaries[column] + 1, to: boundaries[column + 1] }
    const cell = trimmedSpan(line, raw)
    if (cell.from === cell.to) continue
    result.push(ctx.elt(
      'TableCell',
      absoluteStart + cell.from,
      absoluteStart + cell.to,
      ctx.parser.parseInline(line.slice(cell.from, cell.to), absoluteStart + cell.from),
    ))
  }
  for (const boundary of boundaries) {
    result.push(ctx.elt('TableDelimiter', absoluteStart + boundary, absoluteStart + boundary + 1))
  }
  result.sort((a, b) => a.from - b.from || a.to - b.to)
  return result
}

export const gridTableParser: BlockParser = {
  name: 'grid-table',
  parse: (ctx, line) => {
    const opening = line.text.slice(line.pos)
    if (!GRID_BORDER.test(opening) || opening.includes('=')) return false
    const boundaries = gridBoundaries(opening)
    if (boundaries.length < 2) return false

    const start = ctx.lineStart + line.pos
    const children: Element[] = [ctx.elt('TableDelimiter', start, start + opening.length)]
    let rowStart = -1
    let rowLines: Array<{ text: string, start: number }> = []
    let headerClosed = false
    let lastEnd = start + opening.length
    let closed = false

    const flushRow = (asHeader: boolean): void => {
      if (rowStart < 0 || rowLines.length === 0) return
      const rowChildren: Element[] = []
      // A physical line for each cell line. Multi-line grid cells remain within
      // one logical TableHeader/TableRow container; the AST adapter can join
      // their child nodes without fabricating extra rows.
      for (const physical of rowLines) {
        rowChildren.push(...gridCells(ctx, physical.text, physical.start, boundaries))
      }
      const rowEnd = rowLines[rowLines.length - 1].start + rowLines[rowLines.length - 1].text.length
      children.push(ctx.elt(asHeader ? 'TableHeader' : 'TableRow', rowStart, rowEnd, rowChildren))
      rowStart = -1
      rowLines = []
    }

    while (ctx.nextLine()) {
      const text = line.text.slice(line.pos)
      const absolute = ctx.lineStart + line.pos
      if (GRID_CONTENT.test(text) && sameGridGeometry(text, boundaries)) {
        if (rowStart < 0) rowStart = absolute
        rowLines.push({ text, start: absolute })
        lastEnd = absolute + text.length
        continue
      }
      if (!GRID_BORDER.test(text) || !sameGridGeometry(text, boundaries)) {
        return false
      }

      const headerSeparator = text.includes('=')
      flushRow(headerSeparator && !headerClosed)
      if (headerSeparator) headerClosed = true
      children.push(ctx.elt('TableDelimiter', absolute, absolute + text.length))
      lastEnd = absolute + text.length

      // A border with no following grid-content line closes the table. Peek is
      // sufficient here: gridTableWith' likewise stops at the completed border.
      const next = ctx.peekLine()
      if (!GRID_CONTENT.test(next)) {
        closed = true
        ctx.nextLine()
        break
      }
    }

    if (!closed || rowStart >= 0) return false
    ctx.addElement(ctx.elt('Table', start, lastEnd, children))
    return true
  },
}
