# 2. LaTeX math delimiters `\[ \]` and `\( \)`

Upstream Zettlr only recognizes `$`/`$$`. This fork adds the LaTeX delimiters, and
they must be threaded through **four** layers:

- **Parser:** the Pandoc grammar fork, `vendor/lezer-markdown-pandoc/src/pandoc/math.ts`
  (registered in `pandoc/index.ts`): `inlineMathParser` (`$ $`, `$$ $$`) and
  `singleBackslashMathParser` (`\( \)`, `\[ \]`, spanning newlines; both run
  `before: 'Escape'` or the backslash opener is eaten as an escape). A display
  equation is an `InlineCode` node in a `Paragraph`, as Pandoc reads it as an
  inline `Math` element; its first `CodeMark` is `$$` or `\[`. A consumer that
  looks for display math tests that mark (`mathDisplayForOpen`), not the node
  name. The `blockMathParser` of the same file is registered nowhere.
- **TeX overlay:** `packages/pandoc-editor/src/parser/math-parser.ts`
  (`mathCodeParse`, the stex parser inside a math node), used by
  `packages/pandoc-editor/src/parser/markdown-parser.ts`.
- **Shared pure helpers:** `packages/pandoc-editor/src/util/math-delimiters.ts`
  (`MATH_DELIMITERS`, `mathDisplayForOpen`, `stripMathDelimiters`). **This module must
  import nothing (no CodeMirror/lezer)** — `markdown-to-html` runs in the main
  process, and dragging the editor graph into that Node bundle breaks the webpack
  build.
- **AST:** `source/common/modules/markdown-utils/markdown-ast/index.ts` (treats `\[`
  and `\(` code marks as math).
- **HTML (`md2html`):** `source/common/modules/markdown-utils/markdown-to-html.ts`.
- **Live editor widget:** `packages/pandoc-editor/src/renderers/render-math.ts`.
- **Pandoc exports:** `writeDefaults` (`commands/exporter/index.ts`) gives a
  Markdown reader `tex_math_single_backslash`, as the PDF recipe does. Proof:
  `test/export-document.spec.ts` (LaTeX and Word).
