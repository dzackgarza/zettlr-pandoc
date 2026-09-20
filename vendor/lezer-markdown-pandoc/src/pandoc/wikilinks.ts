/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `wikilink` (line 1887), with
 * Ext_wikilinks_title_after_pipe / Ext_wikilinks_title_before_pipe.
 */

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Zettelkasten Link Parser
 * CVM-Role:        InlineParser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A small parser that adds Zettelkasten link elements to the tree.
 *
 * END HEADER
 */

import type { DelimiterType, InlineParser } from '../markdown'

export interface ZknLinkParserConfig {
  /**
   * Describes whether internal Zettelkasten/Wiki-Links should follow the format
   * `[[link|title]]`, or `[[title|link]]`. If not provided, the parser falls
   * back to the default `[[link|title]]`.
   *
   * * The `[[link|title]]` syntax is used by:
   *   * Obsidian
   *   * Wikipedia (MediaWiki)
   *   * VimWiki
   *   * Orgmode
   * * The `[[title|link]]` syntax is used by:
   *   * GitHub
   */
  format?: 'link|title'|'title|link'
}

const ZknLinkDelimiter: DelimiterType = {}

// This parser adds Zettelkasten links to the syntax tree.
export const zknLinkParser = function (config?: ZknLinkParserConfig): InlineParser {
  return {
    // This parser should only match zettelkasten-style links
    name: 'zkn-links',
    before: 'Link', // In case of default [[links]], the inner brackets would be detected as links
    parse: (ctx, next, pos) => {
      if (next === 91 && ctx.char(pos + 1) === 91) { // 91 === '['
        ctx.addDelimiter(ZknLinkDelimiter, pos, pos + 2, true, false)

        // Return -1 so the default link parser can add its delimiters
        return -1
      }

      let opening = null
      if (next === 93 && ctx.char(pos + 1) === 93) {  // 93 === ']'
        opening = ctx.findOpeningDelimiter(ZknLinkDelimiter)
      }
      if (opening === null) { return -1}

      const delim = ctx.getDelimiterAt(opening)
      if (delim === null) { return -1 }

      // A successful wikilink owns both authored opening brackets. Clear any
      // speculative Pandoc-span companions at those exact positions while
      // leaving an earlier outer span opener intact.
      ctx.discardLinkCompanionDelimiters(delim.from, delim.from + 1)
      ctx.discardLinkCompanionDelimiters(delim.from + 1, delim.from + 2)

      // Remove any elements that were parsed internally
      ctx.takeContent(opening)

      ctx.addDelimiter(ZknLinkDelimiter, pos, pos + 2, false, true)

      const contents = ctx.slice(delim.to, pos)
      const pipeIdx = contents.indexOf('|')

      // Pandoc's `wikilink` only rejects control whitespace in the URL side of
      // the construct. With `wikilinks_title_after_pipe`, that is the text
      // before the first pipe; with the inverse dialect it is the text after.
      // Reference: Markdown.hs `wikilink`, guard on `url` immediately before
      // constructing the Link/Image.
      const titleFirst = config?.format === 'title|link'
      const target = pipeIdx < 0
        ? contents
        : titleFirst ? contents.slice(pipeIdx + 1) : contents.slice(0, pipeIdx)
      if (/\n|\r|\f|\t/u.test(target)) {
        return -1
      }

      const children = []
      // NOTE: In order to avoid either empty links or empty titles and having
      // to deal with these edge cases, we disallow putting pipes at either the
      // beginning or the end of a link.
      if (pipeIdx > 0 && pipeIdx < contents.length) {
        // The link contains both a link and a title.
        children.push(
          ctx.elt(titleFirst ? 'ZknLinkTitle' : 'ZknLinkContent', delim.to, delim.to + pipeIdx),
          ctx.elt('ZknLinkPipe', delim.to + pipeIdx,  delim.to + pipeIdx + 1),
          ctx.elt(titleFirst ? 'ZknLinkContent' : 'ZknLinkTitle', delim.to + pipeIdx + 1, pos)
        )
      } else {
        // The link equals the title, no pipe found
        children.push(ctx.elt('ZknLinkContent', delim.to, pos))
      }

      const openingMark = ctx.elt('ZknLinkMark', delim.from, delim.to)
      const closingMark = ctx.elt('ZknLinkMark', pos, pos + 2)

      return ctx.addElement(ctx.elt('ZknLink', delim.from, pos + 2, [ openingMark, ...children, closingMark ]))
    }
  }
}
