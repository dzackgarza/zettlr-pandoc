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

import type { BlockParser } from '../markdown'

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

    const yamlLines: string[] = []
    while (ctx.nextLine() && !/^(?:-{3}|\.{3})$/.test(line.text)) {
      yamlLines.push(line.text)
    }

    if (!/^(?:-{3}|\.{3})$/.test(line.text)) {
      return false
    }

    if (yamlLines.length > 0 && yamlLines[0].trim() === '') {
      return false
    }

    const wrapperNode = ctx.elt('YAMLFrontmatter', openingStart, ctx.lineStart + 3, [
      ctx.elt('YAMLFrontmatterStart', openingStart, openingStart + 3),
      ctx.elt('CodeText', openingStart + 4, ctx.lineStart - 1),
      ctx.elt('YAMLFrontmatterEnd', ctx.lineStart, ctx.lineStart + 3)
    ])

    ctx.nextLine()
    ctx.addElement(wrapperNode)
    return true
  }
}
