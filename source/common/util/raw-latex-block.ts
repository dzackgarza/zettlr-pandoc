/**
 * Compatibility surface for consumers that need Pandoc raw-TeX structure.
 * Recognition itself is owned by the vendored @lezer/markdown Pandoc fork.
 */

export {
  rawLatexEnvironmentAtStart,
  rawLatexBlockStartsAt,
  rawLatexEnvironmentEnd,
  rawLatexBlockEndAtStart,
  rawBlockSourceFromNode,
  rawBlockLineRangesFromNode,
  type RawBlockSyntaxNode,
} from '@lezer/markdown'
