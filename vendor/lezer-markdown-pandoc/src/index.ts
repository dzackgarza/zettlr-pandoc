import {parser} from "./markdown"
import type {MarkdownExtension} from "./markdown"
import {Subscript, Superscript, TaskList} from "./extension"
import {PandocSyntax} from "./pandoc/index"

export {parser, MarkdownParser, MarkdownConfig, MarkdownExtension,
        NodeSpec, InlineParser, BlockParser, LeafBlockParser,
        Line, Element, LeafBlock, DelimiterType, BlockContext, InlineContext} from "./markdown"
export {parseCode} from "./nest"
export {Table, TaskList, Strikethrough, Autolink, GFM, Subscript, Superscript, Emoji} from "./extension"
export {
  scanPandocAttributeList,
  scanPandocFencedDivOpening,
  citationParser,
  CITATION_NODES,
  parseCitationLocator,
  parseCitationSuffix,
  rawLatexEnvironmentAtStart,
  rawLatexBlockStartsAt,
  rawLatexEnvironmentEnd,
  rawLatexBlockEndAtStart,
  rawLatexBlockSequenceEndAtStart,
  rawLatexInlineEndAtStart,
  pandocLatexMathEnvironmentAtStart,
  rawBlockSourceFromNode,
  rawBlockLineRangesFromNode,
} from "./pandoc/index"
export type {
  PandocMarkdownOptions,
  PandocAttributeListScan,
  PandocAttributeToken,
  PandocFencedDivOpeningScan,
  PandocSyntaxScan,
  Citation,
  CiteItem,
  CSL_LOCATOR_TERM,
  PandocLatexMathEnvironment,
  RawBlockSyntaxNode,
  ZknLinkParserConfig,
} from "./pandoc/index"

/**
 * Complete Pandoc-flavored Markdown extension supported by this fork.
 * The reused Lezer extensions correspond to Pandoc's default superscript,
 * subscript, and task-list extensions. Strikeout is fork-owned because GFM's
 * delimiter-run behavior is not Pandoc's `strikeout` parser.
 */
export function Pandoc(options: import("./pandoc/index").PandocMarkdownOptions = {}): MarkdownExtension {
  return [Superscript, Subscript, TaskList, PandocSyntax(options)]
}

export function createPandocParser(options: import("./pandoc/index").PandocMarkdownOptions = {}) {
  return parser.configure(Pandoc(options))
}
