/**
 * Differential oracle for the vendored Lezer Pandoc table grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * Text/Pandoc/Readers/Markdown.hs `gridTable`, `pipeBreak`, `pipeTable`,
 * `pipeTableRow`, `pipeTableCell`, and `pipeTableHeaderPart`; grid geometry
 * delegates to Text/Pandoc/Parsing/GridTable.hs and Text.GridTable.
 */

import { strict as assert } from 'node:assert'
import { markdownToAST } from 'source/common/modules/markdown-utils'
import type { ASTNode, Table } from 'source/common/modules/markdown-utils/markdown-ast'
import { execPandocReference } from './pandoc-reference'

const READER = [
  'markdown',
  '+pipe_tables',
  '+grid_tables',
  '+raw_tex',
  '+tex_math_dollars',
  '+tex_math_single_backslash'
].join('')

type Alignment = null|'left'|'center'|'right'

interface TableSummary {
  columns: number
  alignment: Alignment[]
  header: string[][]
  body: string[][]
}

function pandocInlineText (value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(pandocInlineText).join('')
  }
  if (typeof value !== 'object' || value === null) return ''
  const record = value as { t?: string, c?: unknown }
  if (record.t === 'Str' && typeof record.c === 'string') return record.c
  if (record.t === 'Space' || record.t === 'SoftBreak' || record.t === 'LineBreak') return ' '
  if (record.t === 'Code' && Array.isArray(record.c) && typeof record.c[1] === 'string') return record.c[1]
  if (record.t === 'Math' && Array.isArray(record.c) && typeof record.c[1] === 'string') return record.c[1]
  return pandocInlineText(record.c)
}

function pandocRows (rows: unknown): string[][] {
  if (!Array.isArray(rows)) return []
  return rows.map(row => {
    if (!Array.isArray(row) || !Array.isArray(row[1])) return []
    return row[1].map(cell => {
      if (!Array.isArray(cell)) return ''
      return pandocInlineText(cell[4]).replace(/\s+/gu, ' ').trim()
    })
  })
}

function pandocSummary (source: string): TableSummary|undefined {
  const raw = execPandocReference(['-f', READER, '-t', 'json'], { input: source })
  const document = JSON.parse(raw) as { blocks?: Array<{ t?: string, c?: unknown }> }
  const table = document.blocks?.find(block => block.t === 'Table')
  if (table === undefined || !Array.isArray(table.c)) return undefined

  const colspecs = Array.isArray(table.c[2]) ? table.c[2] : []
  const alignment: Alignment[] = colspecs.map(spec => {
    if (!Array.isArray(spec) || typeof spec[0] !== 'object' || spec[0] === null) return null
    switch ((spec[0] as { t?: string }).t) {
      case 'AlignLeft': return 'left'
      case 'AlignCenter': return 'center'
      case 'AlignRight': return 'right'
      default: return null
    }
  })

  const head = table.c[3]
  const header = Array.isArray(head) ? pandocRows(head[1]) : []
  const bodies = Array.isArray(table.c[4]) ? table.c[4] : []
  const body: string[][] = []
  for (const tableBody of bodies) {
    if (!Array.isArray(tableBody)) continue
    body.push(...pandocRows(tableBody[2]), ...pandocRows(tableBody[3]))
  }
  return { columns: colspecs.length, alignment, header, body }
}

function editorSummary (source: string): TableSummary|undefined {
  const document = markdownToAST(source)
  if (document.type !== 'Document') return undefined
  const table = document.children.find((node: ASTNode): node is Table => node.type === 'Table')
  if (table === undefined) return undefined
  return {
    columns: table.alignment.length,
    alignment: table.alignment,
    header: table.rows.filter(row => row.isHeaderOrFooter).map(row => row.cells.map(cell => cell.textContent)),
    body: table.rows.filter(row => !row.isHeaderOrFooter).map(row => row.cells.map(cell => cell.textContent))
  }
}

const exactCases = [
  {
    name: 'ordinary two-column pipe table',
    source: 'A|B\n-|-\nC|D\n'
  },
  {
    name: 'pipe table alignment markers',
    source: 'A | B | C\n:--|:--:|--:\nD | E | F\n'
  },
  {
    name: 'header-only one-column pipe table',
    source: '| A |\n|---|\n'
  },
  {
    name: 'extra body cells are truncated to the delimiter width',
    source: 'A|B\n-|-\nC|D|E\n'
  },
  {
    name: 'missing body cells are padded when outer pipes make the row tabular',
    source: '|A|B|\n|-|-|\n|C|\n'
  },
  {
    name: 'a non-pipe line terminates the table without a blank line',
    source: 'A|B\n-|-\nprose\n'
  },
  {
    name: 'grid table with a header separator',
    source: '+---+---+\n| A | B |\n+===+===+\n| C | D |\n+---+---+\n'
  },
  {
    name: 'grid table without a header',
    source: '+---+---+\n| A | B |\n+---+---+\n'
  }
] as const

const protectedPipeCases = [
  {
    name: 'pipe in inline code is not a cell separator',
    source: '`a|b`|C\n---|---\nD|E\n'
  },
  {
    name: 'pipe in dollar math is not a cell separator',
    source: '$a|b$|C\n---|---\nD|E\n'
  },
  {
    name: 'escaped pipe is not a cell separator',
    source: 'a\\|b|C\n---|---\nD|E\n'
  }
] as const

const negativeCases = [
  {
    name: 'one-column delimiter without an outer pipe is prose',
    source: 'A|B\n---\nC|D\n'
  },
  {
    name: 'malformed delimiter row is prose',
    source: 'A|B\n--x|---\nC|D\n'
  },
  {
    name: 'a header with no pipe cannot start a pipe table',
    source: 'Header\n|---|---|\nA|B\n'
  }
] as const

describe('Pandoc table differential oracle', function () {
  this.timeout(60000)

  for (const testCase of exactCases) {
    it(`matches Pandoc for ${testCase.name}`, function () {
      assert.deepEqual(editorSummary(testCase.source), pandocSummary(testCase.source))
    })
  }

  for (const testCase of protectedPipeCases) {
    it(`matches Pandoc cell boundaries when ${testCase.name}`, function () {
      const editor = editorSummary(testCase.source)
      const pandoc = pandocSummary(testCase.source)
      assert.ok(editor !== undefined && pandoc !== undefined, 'both readers must recognize a table')
      assert.equal(editor.columns, pandoc.columns)
      assert.deepEqual(editor.header.map(row => row.length), pandoc.header.map(row => row.length))
      assert.deepEqual(editor.body.map(row => row.length), pandoc.body.map(row => row.length))
    })
  }

  for (const testCase of negativeCases) {
    it(`matches Pandoc rejection for ${testCase.name}`, function () {
      assert.equal(pandocSummary(testCase.source), undefined, 'oracle fixture must be rejected by Pandoc')
      assert.equal(editorSummary(testCase.source), undefined)
    })
  }
})
