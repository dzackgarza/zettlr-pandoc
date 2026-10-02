/**
 * Compatibility surface for consumers that need Pandoc raw-TeX structure.
 * Recognition itself is owned by the vendored @lezer/markdown Pandoc fork.
 */

export {
  type RawBlockSyntaxNode,
  rawBlockLineRangesFromNode,
  rawBlockSourceFromNode,
  rawLatexBlockEndAtStart,
  rawLatexBlockStartsAt,
  rawLatexEnvironmentAtStart,
  rawLatexEnvironmentEnd,
} from "@lezer/markdown";
