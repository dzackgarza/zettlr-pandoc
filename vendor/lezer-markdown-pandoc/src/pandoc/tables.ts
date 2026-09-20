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
import type { Input } from '@lezer/common'
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
    // Pandoc's paragraph `endline` does not recognize pipe-table starts as an
    // interrupting block. A pipe table is parsed only when its header begins a
    // fresh block (after a blank or other completed block). The old editor
    // parser inherited GFM-style mid-paragraph table interruption here.
    if (ctx.parser.pandocParagraphContinuation) return false
    if (leaf.parsers.some(parser => parser instanceof PandocPipeTableParser)) return false
    const current = line.text.slice(line.basePos)
    if (scanPipeRow(current) === null) return false
    return scanPipeDelimiter(ctx.peekLine()) !== null
  },
}

// Grid-table geometry is delegated by Pandoc to gridtables. The reference
// implementation used by Pandoc 3.10.2 is gridtables 0.1.1.0, commit
// 5d4730fe39911ddad49797a9e800cdd5a9904016:
//   Text/GridTable/Parse.hs  `gridTable`, `tableLine`
//   Text/GridTable/Trace.hs  `traceLines`, `scanRight`, `scanDown`,
//                            `scanLeft`, `scanUp`, `lastCellInRow`,
//                            `scanRestOfLines`, `getLines`
//
// The tracing algorithm is intentionally forgiving. An internal `+` in the
// opening border is only a candidate column edge. If no closed cell can be
// traced down from it, tracing continues to a later edge or even to the padded
// physical line end. Thus visually malformed input can legitimately collapse
// to fewer columns instead of being rejected. This is important Pandoc
// behavior, not error recovery invented by the editor.

type GridAlignment = 'left'|'center'|'right'|null

interface GridPhysicalLine {
  text: string
  start: number
}

interface GridCellTrace {
  top: number
  left: number
  bottom: number
  right: number
}

interface GridTrace {
  cells: GridCellTrace[]
  rowSeparators: number[]
  columnSeparators: number[]
  headerBoundary?: number
  alignment: GridAlignment[]
}

interface BlockContextInput {
  input: Input
}

function tableBlockInput (ctx: BlockContext): Input {
  return (ctx as unknown as BlockContextInput).input
}

function readGridPhysicalLine (input: Input, from: number): { text: string, next: number } {
  let cursor = from
  let text = ''
  while (cursor < input.length) {
    const chunk = input.chunk(cursor)
    if (chunk.length === 0) break
    const newline = chunk.indexOf('\n')
    if (newline >= 0) {
      text += chunk.slice(0, newline)
      if (text.endsWith('\r')) text = text.slice(0, -1)
      return { text, next: cursor + newline + 1 }
    }
    text += chunk
    cursor += chunk.length
  }
  if (text.endsWith('\r')) text = text.slice(0, -1)
  return { text, next: cursor }
}

function gridSpecs (line: string, fill: '-'|'='): GridAlignment[] | undefined {
  const source = line.trimEnd()
  if (!source.startsWith('+')) return undefined
  const parts = source.slice(1).split('+')
  if (parts.length === 0 || parts[parts.length - 1] !== '') return undefined
  parts.pop()
  const specs: GridAlignment[] = []
  for (const part of parts) {
    const run = fill === '-' ? '-+' : '=+'
    if (!new RegExp(`^:?${run}:?$`, 'u').test(part)) return undefined
    specs.push(part.startsWith(':') && part.endsWith(':')
      ? 'center'
      : part.startsWith(':')
        ? 'left'
        : part.endsWith(':') ? 'right' : null)
  }
  return specs
}

function collectGridLines (ctx: BlockContext, line: Line): GridPhysicalLine[] | undefined {
  const opening = line.text.slice(line.pos).trimEnd()
  if (gridSpecs(opening, '-') === undefined) return undefined

  const lines: GridPhysicalLine[] = [{ text: opening, start: ctx.lineStart + line.pos }]
  const input = tableBlockInput(ctx)
  let physicalStart = ctx.lineStart
  let current = readGridPhysicalLine(input, physicalStart)
  let cursor = current.next
  // Composite prefixes (`> `, list indentation, etc.) are stable across a
  // table. `basePos` is the prefix already consumed by the active containers;
  // ordinary nonindent spaces are skipped after it just as on the first line.
  const basePrefix = line.basePos

  while (cursor < input.length) {
    physicalStart = cursor
    current = readGridPhysicalLine(input, cursor)
    cursor = current.next
    let pos = Math.min(basePrefix, current.text.length)
    pos = skipHorizontalSpace(current.text, pos)
    const text = current.text.slice(pos).trimEnd()
    if (text[0] !== '+' && text[0] !== '|') break
    lines.push({ text, start: physicalStart + pos })
  }
  return lines.length > 1 ? lines : undefined
}

function gridChar (lines: readonly GridPhysicalLine[], width: number, row: number, column: number): string | undefined {
  if (row < 0 || row >= lines.length || column < 0 || column >= width) return undefined
  return column < lines[row].text.length ? lines[row].text[column] : undefined
}

interface GridScanResult {
  bottom: number
  right: number
  rowSeparators: Set<number>
  columnSeparators: Set<number>
}

function scanGridUp (
  lines: readonly GridPhysicalLine[],
  width: number,
  top: number,
  left: number,
  bottom: number,
): Set<number> | undefined {
  const rows = new Set<number>()
  for (let row = bottom - 1; row > top; row--) {
    const char = gridChar(lines, width, row, left)
    if (char === '+') rows.add(row)
    else if (char !== '|') return undefined
  }
  return rows
}

function scanGridLeft (
  lines: readonly GridPhysicalLine[],
  width: number,
  top: number,
  left: number,
  bottom: number,
  right: number,
): { rowSeparators: Set<number>, columnSeparators: Set<number> } | undefined {
  if (gridChar(lines, width, bottom, left) !== '+') return undefined
  const columns = new Set<number>()
  for (let column = right - 1; column > left; column--) {
    const char = gridChar(lines, width, bottom, column)
    if (char === '+') columns.add(column)
    else if (char !== '-') return undefined
  }
  const rows = scanGridUp(lines, width, top, left, bottom)
  return rows === undefined ? undefined : { rowSeparators: rows, columnSeparators: columns }
}

function scanGridDown (
  lines: readonly GridPhysicalLine[],
  width: number,
  top: number,
  left: number,
  right: number,
): GridScanResult | undefined {
  const rows = new Set<number>()
  for (let row = top + 1; row < lines.length; row++) {
    const char = gridChar(lines, width, row, right)
    if (char === '+') {
      rows.add(row)
      const leftScan = scanGridLeft(lines, width, top, left, row, right)
      if (leftScan !== undefined) {
        for (const value of leftScan.rowSeparators) rows.add(value)
        return {
          bottom: row,
          right,
          rowSeparators: rows,
          columnSeparators: leftScan.columnSeparators,
        }
      }
      continue
    }
    if (char === '|') continue
    // gridtables permits an unterminated final column to extend through
    // arbitrary/missing characters at the padded right edge.
    if (right === width - 1) continue
    return undefined
  }
  return undefined
}

function scanGridRightRestOfLine (
  lines: readonly GridPhysicalLine[],
  width: number,
  left: number,
  bottom: number,
): boolean {
  if (gridChar(lines, width, bottom, left) !== '+') return false
  for (let column = left + 1; column < width; column++) {
    const char = gridChar(lines, width, bottom, column)
    if (char !== '+' && char !== '-' && char !== undefined) return false
  }
  return true
}

function scanGridRestOfLines (
  lines: readonly GridPhysicalLine[],
  width: number,
  top: number,
  left: number,
): GridScanResult | undefined {
  for (let row = top + 1; row < lines.length; row++) {
    if (scanGridRightRestOfLine(lines, width, left, row)) {
      return {
        bottom: row,
        right: width - 1,
        rowSeparators: new Set([row]),
        columnSeparators: new Set([width - 1]),
      }
    }
  }
  return undefined
}

function scanGridRight (
  lines: readonly GridPhysicalLine[],
  width: number,
  top: number,
  left: number,
): GridScanResult | undefined {
  const seenColumns = new Set<number>()
  for (let column = left + 1; column < width; column++) {
    const char = gridChar(lines, width, top, column)
    if (char === '-') continue
    if (char !== '+') return undefined
    seenColumns.add(column)
    const down = scanGridDown(lines, width, top, left, column)
    if (down !== undefined) {
      for (const value of seenColumns) down.columnSeparators.add(value)
      return down
    }
    // Exact port of gridtables' `lastCellInRow`: after a failed candidate `+`,
    // a padded line end can become the right edge of one forgiving cell.
    if (gridChar(lines, width, top, column + 1) === undefined) {
      const rest = scanGridRestOfLines(lines, width, top, left)
      if (rest !== undefined) return rest
    }
  }
  return undefined
}

function traceGrid (physicalLines: readonly GridPhysicalLine[]): GridTrace | undefined {
  const width = Math.max(...physicalLines.map(line => line.text.length))
  if (width < 2) return undefined
  const partSeparators = physicalLines
    // gridtables' `colSpecsInLine` works against the padded CharGrid and only
    // succeeds when the separator reaches the grid's final column. A visually
    // valid but shorter `+===+===+` line in a wider table is therefore cell
    // content, not a part separator.
    .map((line, row) => ({
      row,
      specs: line.text.length === width ? gridSpecs(line.text, '=') : undefined,
    }))
    .filter((entry): entry is { row: number, specs: GridAlignment[] } => entry.specs !== undefined)

  // gridtables converts `=` separator rows and colon alignment markers to '-'
  // before tracing geometry, but extracts cell content from the original grid.
  const separatorRows = new Set([0, ...partSeparators.map(entry => entry.row)])
  const tracedLines = physicalLines.map((line, row) => ({
    ...line,
    text: separatorRows.has(row) ? line.text.replace(/[=:]/gu, '-') : line.text,
  }))

  const cells: GridCellTrace[] = []
  const rowSeparators = new Set<number>([0])
  const columnSeparators = new Set<number>([0])
  const corners = new Set<string>(['0:0'])
  const seen = new Set<string>()

  while (corners.size > 0) {
    const ordered = [...corners]
      .map(key => key.split(':').map(Number) as [number, number])
      .sort(([ar, ac], [br, bc]) => ar - br || ac - bc)
    const [top, left] = ordered[0]
    const key = `${top}:${left}`
    corners.delete(key)
    if (seen.has(key)) continue
    seen.add(key)

    const scan = scanGridRight(tracedLines, width, top, left)
    if (scan === undefined) continue
    cells.push({ top, left, bottom: scan.bottom, right: scan.right })
    for (const value of scan.rowSeparators) rowSeparators.add(value)
    for (const value of scan.columnSeparators) columnSeparators.add(value)
    corners.add(`${top}:${scan.right}`)
    corners.add(`${scan.bottom}:${left}`)
  }

  if (cells.length === 0) return undefined
  const rows = [...rowSeparators].sort((a, b) => a - b)
  const columns = [...columnSeparators].sort((a, b) => a - b)
  if (rows.length < 2 || columns.length < 2) return undefined

  const headerSeparator = partSeparators.find(entry => rows.includes(entry.row))
  const firstLineSpecs = physicalLines[0].text.length === width
    ? gridSpecs(physicalLines[0].text, '-')
    : undefined
  const specs = partSeparators[0]?.specs ?? firstLineSpecs ?? []
  return {
    cells,
    rowSeparators: rows,
    columnSeparators: columns,
    headerBoundary: headerSeparator?.row,
    alignment: Array.from({ length: columns.length - 1 }, (_, index) => specs[index] ?? null),
  }
}

function gridColumnNodeName (alignment: GridAlignment): string {
  if (alignment === 'left') return 'GridTableColumnLeft'
  if (alignment === 'center') return 'GridTableColumnCenter'
  if (alignment === 'right') return 'GridTableColumnRight'
  return 'GridTableColumnDefault'
}

function gridCellElement (
  ctx: BlockContext,
  lines: readonly GridPhysicalLine[],
  cell: GridCellTrace,
): Element {
  const physical = lines.slice(cell.top + 1, cell.bottom)
  const spans = physical.map(line => {
    let from = Math.min(cell.left + 1, line.text.length)
    let to = Math.min(cell.right, line.text.length)
    return { line, from, to }
  })
  // Pandoc GridTable.removeOneLeadingSpace drops one leading space iff every
  // physical line in the cell starts with one (empty/missing lines qualify).
  const dropLeading = spans.every(({ line, from, to }) => from >= to || line.text[from] === ' ')
  const lineElements: Element[] = []
  for (const span of spans) {
    let from = span.from + (dropLeading && span.from < span.to ? 1 : 0)
    let to = span.to
    while (to > from && (span.line.text[to - 1] === ' ' || span.line.text[to - 1] === '\t')) to--
    const absoluteFrom = span.line.start + from
    const absoluteTo = span.line.start + to
    lineElements.push(ctx.elt(
      'TableCellLine',
      absoluteFrom,
      absoluteTo,
      ctx.parser.parseInline(span.line.text.slice(from, to), absoluteFrom),
    ))
  }
  const from = lineElements[0]?.from ?? lines[cell.top].start + cell.left + 1
  const to = lineElements[lineElements.length - 1]?.to ?? from
  return ctx.elt('TableCell', from, to, lineElements)
}

export const gridTableParser: BlockParser = {
  name: 'grid-table',
  parse: (ctx, line) => {
    const lines = collectGridLines(ctx, line)
    if (lines === undefined) return false
    const trace = traceGrid(lines)
    if (trace === undefined) return false

    const start = lines[0].start
    const openingChildren = trace.alignment.map((alignment, index) => {
      const left = trace.columnSeparators[index]
      const right = trace.columnSeparators[index + 1]
      const from = start + Math.min(lines[0].text.length, left + 1)
      const to = start + Math.min(lines[0].text.length, Math.max(left + 1, right))
      return ctx.elt(gridColumnNodeName(alignment), from, to)
    })
    const children: Element[] = [
      ctx.elt('TableDelimiter', start, start + lines[0].text.length, openingChildren),
    ]

    for (let rowIndex = 0; rowIndex + 1 < trace.rowSeparators.length; rowIndex++) {
      const top = trace.rowSeparators[rowIndex]
      const bottom = trace.rowSeparators[rowIndex + 1]
      const rowCells = trace.cells
        .filter(cell => cell.top === top)
        .sort((a, b) => a.left - b.left)
        .map(cell => gridCellElement(ctx, lines, cell))
      const rowFrom = lines[Math.min(top + 1, lines.length - 1)].start
      const bottomLine = lines[Math.min(bottom, lines.length - 1)]
      const rowTo = bottomLine.start
      const isHeader = trace.headerBoundary !== undefined && bottom <= trace.headerBoundary
      children.push(ctx.elt(isHeader ? 'TableHeader' : 'TableRow', rowFrom, rowTo, rowCells))
    }

    // Preserve authored border ranges for source-aware consumers. Only the
    // first delimiter carries the semantic column children used by the AST.
    for (let index = 1; index < lines.length; index++) {
      if (lines[index].text.startsWith('+')) {
        children.push(ctx.elt(
          'TableDelimiter',
          lines[index].start,
          lines[index].start + lines[index].text.length,
        ))
      }
    }
    children.sort((a, b) => a.from - b.from || a.to - b.to)

    // Commit BlockContext movement only after the non-mutating trace succeeds.
    for (let index = 1; index < lines.length; index++) {
      if (!ctx.nextLine()) return false
    }
    const end = lines[lines.length - 1].start + lines[lines.length - 1].text.length
    ctx.addElement(ctx.elt('Table', start, end, children))
    ctx.nextLine()
    return true
  },
}
