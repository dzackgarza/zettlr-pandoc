/**
 * Pandoc Markdown extensions owned by this @lezer/markdown fork.
 *
 * The grammar is not specified from Zettlr examples. Every rule in this
 * directory names the Pandoc 3.10.2 implementation it ports, pinned at commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918. Differential tests additionally
 * invoke the real `pandoc` reader as an executable oracle.
 */

import type { MarkdownExtension } from '../markdown'
import { pandocAttributesParser } from './attributes-parser'
import { citationParser } from './citations'
import { pandocDivComposite, pandocDivParser, pandocSpanParser } from './div-span'
import { footnoteComposite, footnoteParser, footnoteRefParser } from './footnotes'
import { frontmatterParser } from './frontmatter'
import { pandocLinkParser } from './link'
import { blockMathParser, inlineMathParser, singleBackslashMathParser } from './math'
import { rawLatexBlockParser, rawLatexInlineParser } from './raw-latex'
import { gridTableParser, pipeTableParser } from './tables'
import { type ZknLinkParserConfig, zknLinkParser } from './wikilinks'

export interface PandocMarkdownOptions {
  /** Pandoc wikilink extension spelling selected by the application. */
  wikilinks?: ZknLinkParserConfig['format']
}

const pandocNodes: MarkdownExtension = {
  defineNodes: [
    { name: 'YAMLFrontmatter', block: true },
    'YAMLFrontmatterStart',
    'YAMLFrontmatterEnd',

    'Citation',
    'CitationMark',
    'CitationPrefix',
    'CitationSuppressAuthorFlag',
    'CitationAtSign',
    'CitationCitekey',
    'CitationLocator',
    'CitationSuffix',

    'Footnote',
    {
      name: 'FootnoteRef',
      block: true,
      composite: footnoteComposite,
    },
    'FootnoteRefLabel',

    'ZknLink',
    'ZknLinkMark',
    'ZknLinkContent',
    'ZknLinkTitle',
    'ZknLinkPipe',

    'PandocAttribute',
    'PandocAttributeMark',
    {
      name: 'PandocDiv',
      block: true,
      composite: pandocDivComposite,
    },
    'PandocDivInfo',
    'PandocDivMark',
    'PandocSpan',
    'PandocSpanMark',

    { name: 'RawBlock', block: true },
    'RawBlockContent',
    'RawInline',
    'RawInlineContent',

    { name: 'Table', block: true },
    'TableHeader',
    'TableRow',
    'TableCell',
    'TableDelimiter',
  ],
}

/**
 * Return the Pandoc-flavored Markdown grammar used by the editor.
 *
 * The four reused Lezer extension implementations correspond to Pandoc's
 * default Ext_strikeout, Ext_superscript, Ext_subscript, and Ext_task_lists.
 * Pandoc reference: Markdown.hs `strikeout` (1749), `superscript` (1763),
 * `subscript` (1776), and list-item task conversion around line 981 at the
 * pinned reference commit above. Their acceptance belongs to the same Pandoc
 * differential corpus as the fork-owned parsers.
 */
export function PandocSyntax (options: PandocMarkdownOptions = {}): MarkdownExtension {
  return [
    pandocNodes,
    {
      parseBlock: [
        pandocDivParser,
        rawLatexBlockParser,
        frontmatterParser,
        blockMathParser,
        footnoteRefParser,
        gridTableParser,
        pipeTableParser,
      ],
      parseInline: [
        pandocSpanParser,
        inlineMathParser,
        singleBackslashMathParser,
        rawLatexInlineParser,
        footnoteParser,
        citationParser,
        zknLinkParser({ format: options.wikilinks }),
        pandocLinkParser,
        pandocAttributesParser,
      ],
    },
  ]
}

export {
  scanPandocAttributeList,
  scanPandocFencedDivOpening,
  type PandocAttributeListScan,
  type PandocAttributeToken,
  type PandocFencedDivOpeningScan,
  type PandocSyntaxScan,
} from './attribute-syntax'
export {
  citationParser,
  NODES as CITATION_NODES,
  parseCitationLocator,
  parseCitationSuffix,
  type Citation,
  type CiteItem,
  type CSL_LOCATOR_TERM,
} from './citations'
export {
  rawLatexEnvironmentAtStart,
  rawLatexBlockStartsAt,
  rawLatexEnvironmentEnd,
  rawLatexBlockEndAtStart,
  rawLatexInlineEndAtStart,
  rawBlockSourceFromNode,
  rawBlockLineRangesFromNode,
  type RawBlockSyntaxNode,
} from './raw-latex-syntax'
export { type ZknLinkParserConfig } from './wikilinks'
