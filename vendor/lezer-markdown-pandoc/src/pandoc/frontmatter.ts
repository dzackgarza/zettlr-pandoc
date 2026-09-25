/**
 * Pandoc YAML metadata block grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Metadata.hs `yamlMetaBlock` (line 171) and
 * `stopLine`, called by Text/Pandoc/Readers/Markdown.hs `yamlMetaBlock'`
 * (line 310). The editor's YAML language mount is deliberately outside this
 * package; this module owns only Markdown syntax.
 */

import type { Input } from '@lezer/common'
import type { BlockContext, BlockParser } from '../markdown'

interface BlockContextInput {
  /** @lezer/markdown exposes this at runtime but marks it internal in the d.ts. */
  input: Input
}

function blockInput (ctx: BlockContext): Input {
  return (ctx as unknown as BlockContextInput).input
}

interface FrontmatterExtent {
  bodyFrom: number
  bodyTo: number
  closeFrom: number
  closeTo: number
  linesToClose: number
}

/**
 * Non-mutating port of Pandoc Metadata.hs `yamlMetaBlock` / `stopLine`.
 * Lezer cannot roll BlockContext back after `nextLine()`, so recognition must
 * be complete before the block parser advances at all.
 */
function frontmatterExtent (ctx: BlockContext, openingStart: number): FrontmatterExtent | undefined {
  const source = blockInput(ctx).read(openingStart, blockInput(ctx).length)
  if (!source.startsWith('---')) return undefined

  const openingNewline = source.indexOf('\n')
  if (openingNewline < 0) return undefined
  const bodyFrom = openingStart + openingNewline + 1
  let cursor = openingNewline + 1
  let linesToClose = 1
  let firstBodyLine = true

  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor)
    const lineEnd = newline < 0 ? source.length : newline
    const line = source.slice(cursor, lineEnd)

    if (firstBodyLine && line.trim() === '') {
      // Pandoc: `notFollowedBy blankline` immediately after the opener.
      return undefined
    }
    firstBodyLine = false

    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) {
      return {
        bodyFrom,
        bodyTo: openingStart + Math.max(openingNewline + 1, cursor - 1),
        closeFrom: openingStart + cursor,
        closeTo: openingStart + lineEnd,
        linesToClose,
      }
    }

    if (newline < 0) return undefined
    cursor = newline + 1
    linesToClose++
  }
  return undefined
}

export const frontmatterParser: BlockParser = {
  name: 'frontmatter',
  before: 'HorizontalRule',
  parse: (ctx, line) => {
    // Pandoc's YAML metadata block is a block parser, not a document-prologue
    // parser. It may occur after ordinary blocks as long as `---` starts the
    // current block.
    if (line.text !== '---') {
      return false
    }

    const openingStart = ctx.lineStart + line.pos
    const extent = frontmatterExtent(ctx, openingStart)
    if (extent === undefined) {
      return false
    }

    for (let i = 0; i < extent.linesToClose; i++) {
      if (!ctx.nextLine()) return false
    }

    const wrapperNode = ctx.elt('YAMLFrontmatter', openingStart, extent.closeTo, [
      ctx.elt('YAMLFrontmatterStart', openingStart, openingStart + 3),
      ctx.elt('CodeText', extent.bodyFrom, extent.bodyTo),
      ctx.elt('YAMLFrontmatterEnd', extent.closeFrom, extent.closeTo)
    ])

    ctx.nextLine()
    ctx.addElement(wrapperNode)
    return true
  }
}
