/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `attributes` (line 643).
 */

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc Attributes parser
 * CVM-Role:        InlineParser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Recognizes Pandoc attribute lists with the shared
 *                  Pandoc-derived scanner. The scanner, not this adapter,
 *                  owns token/string recognition.
 *
 * END HEADER
 */

import type { InlineParser } from '../markdown'
import { scanPandocAttributeList } from './attribute-syntax'

/** Parses Pandoc attribute lists (for example `{#id .class key="value"}`). */
export const pandocAttributesParser: InlineParser = {
  name: 'pandoc-attributes',
  parse: (ctx, next, pos) => {
    if (next !== 123) { // 123 === '{'
      return -1
    }

    const localFrom = pos - ctx.offset
    const scanned = scanPandocAttributeList(ctx.text, localFrom)
    if (scanned.status !== 'match') {
      return -1
    }

    const attr = scanned.value
    const whitespaceBefore = /^\s*$/.test(ctx.slice(pos - 1, pos))
    const whitespaceAfter = /^\s*$/.test(ctx.text.slice(attr.to))
    // Pandoc attributes are either attached directly to a carrier or finish
    // the inline line. A free-standing brace group in running prose is text.
    if (whitespaceBefore && !whitespaceAfter) {
      return -1
    }

    const from = ctx.offset + attr.from
    const to = ctx.offset + attr.to
    return ctx.addElement(ctx.elt('PandocAttribute', from, to, [
      ctx.elt('PandocAttributeMark', from, from + 1),
      ctx.elt('PandocAttributeMark', to - 1, to),
    ]))
  },
}
