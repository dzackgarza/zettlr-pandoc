# Pandoc grammar provenance

This package is a fork of `@lezer/markdown` 1.7.2. Its Pandoc-specific grammar
is not specified by editor examples or by a second Markdown grammar document.
The reference implementation is Pandoc itself.

Reference release: **Pandoc 3.10.2**
Reference commit: **`f2ee5dfee866aab007a33552acc6bc01810c6918`**

Pandoc 3.10.2 delegates grid-table geometry to **gridtables 0.1.1.0**. The
corresponding reference source is `tarleb/gridtables` commit
**`5d4730fe39911ddad49797a9e800cdd5a9904016`**.

The editor reader dialect is Pandoc Markdown with the system-required additions
`fenced_divs`, `raw_tex`, `tex_math_dollars`, `tex_math_single_backslash`, and
`wikilinks_title_after_pipe`. Pandoc's own default `markdown` reader already
supplies the remaining default Pandoc extensions used here (citations, tables,
footnotes, bracketed spans, attributes, and related syntax).

Every Pandoc-owned parser rule in `src/pandoc/` must satisfy at least one of the
following before it is admitted:

1. its source comment names the literal Pandoc implementation function and the
   pinned reference commit above; or
2. the implementation delegates to a Pandoc-owned parser/oracle directly.

In either case, behavior is covered by a differential test that invokes the
real Pandoc reader and asserts the corresponding Pandoc JSON AST shape before
asserting the Lezer tree shape. A locally invented regex plus an editor-only
fixture is not sufficient evidence for a Pandoc grammar rule.

## Current rule map

| Fork rule | Pandoc reference implementation |
| --- | --- |
| YAML metadata | `Text/Pandoc/Readers/Markdown.hs`: `yamlMetaBlock'` |
| attributes | `Markdown.hs`: `attributes`, `attribute`, `identifierAttr`, `classAttr`, `keyValAttr`, `specialAttr` |
| paragraph interruption | `Markdown.hs`: `endline`, including `blank_before_header`, `blank_before_blockquote`, `lists_without_preceding_blankline`, `codeBlockFenced`, and `notFollowedByDivCloser` |
| block quotes / lazy continuation | `Markdown.hs`: `emailBlockQuoteStart`, `emailBlockQuote`, `emailLine`, plus `endline` |
| list items / lazy continuation | `Markdown.hs`: `bulletListStart`, `orderedListStart`, `listStart`, `listLine`, `rawListItem`, `listContinuation` |
| emphasis / strong | `Markdown.hs`: `enclosure`, `ender`, `one`, `two`, `three`, `strongOrEmph` |
| grid tables | `Markdown.hs`: `gridTable`; `Text/Pandoc/Parsing/GridTable.hs`: `gridTableWith'`; gridtables 0.1.1.0 `Text/GridTable/Parse.hs`: `gridTable`, `tableLine`; `Text/GridTable/Trace.hs`: `traceLines`, `scanRight`, `scanDown`, `scanLeft`, `scanUp`, `lastCellInRow`, `scanRestOfLines`, `getLines` |
| pipe tables | `Markdown.hs`: `pipeBreak`, `pipeTable`, `pipeTableRow`, `pipeTableCell`, `pipeTableHeaderPart`, `scanForPipe` |
| TeX math | `Text/Pandoc/Parsing/Math.hs`: `mathInlineWith`, `mathDisplayWith`, `mathInline`, `mathDisplay`; `Markdown.hs`: `math` |
| LaTeX environments in Markdown | `Text/Pandoc/Readers/LaTeX.hs`: `rawLaTeXInline`, `rawLaTeXBlock`; `Text/Pandoc/Readers/LaTeX/Math.hs`: `inlineEnvironments` (these are `RawInline(tex)` in the Markdown reader, not Markdown `Math`) |
| links/images | `Markdown.hs`: `source`, `link`, `regLink`, `referenceLink` |
| wikilinks | `Markdown.hs`: `wikilink` |
| bracketed spans | `Markdown.hs`: `bracketedSpan` |
| footnotes / inline notes | `Markdown.hs`: `note`, `inlineNote` |
| fenced divs | `Markdown.hs`: `divFenced`, `divFenceEnd` |
| citations | `Markdown.hs`: `cite`, `textualCite`, `normalCite`, `citeList`, `citation`, `prefix`, `suffix` |
| raw TeX | `Text/Pandoc/Readers/LaTeX.hs`: `rawLaTeXBlock`, `rawLaTeXInline`, `inlineEnvironment`, `blockCommands`, `treatAsBlock`; `Markdown.hs`: `rawTeXBlock`, `spnl'`, `rawLaTeXInline'` |
| strikeout | `Markdown.hs`: `strikeout` |
| superscript / subscript | `Markdown.hs`: `superscript`, `subscript` |
| task lists | `Markdown.hs`: list item parsing and `taskListItemFromAscii` application |

CodeMirror language mounting (YAML, TeX highlighting, TikZ, etc.) is deliberately
not part of this grammar. Those are presentation adapters over the syntax tree.
