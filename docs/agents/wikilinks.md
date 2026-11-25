# 8. Workspace wikilinks

- **Resolution:** `source/common/util/wikilink-resolution.ts` (`WikilinkIndex`).
  A `[[target#heading|label]]` target is a relative path (`./`, `../`, absolute:
  resolved against the source file) or a name. A name matches, case-insensitively
  and in this tier order, the Zettelkasten `id`, the path relative to the file's
  workspace root, a suffix of that path, a YAML `aliases` entry, the YAML `title`. The first tier
  with a match decides; two matches in it are ambiguous, never a first match.
  The written form (`canonical`) is the shortest suffix that names the file alone.
- **Owner:** `LinkProvider` (`service-providers/links`) rebuilds the index once
  for each batch of FSAL events that holds a Markdown file or a removal, and
  broadcasts `links` only when the links or the index entries changed. The root
  of a file is the innermost open workspace that contains it.
  Every consumer resolves through it: force-open (with `#heading` → `jump-to-line`),
  hover preview, backlinks, graph, autocomplete (`get-link-targets`), and
  file rename, move and directory rename (`LinkProvider.filesChangedByMove` and
  `retargetProposal` change only the links whose document the move changed;
  the author sees the edit before it is made, [§28](multi-document-edits.md)).
  `[[#heading]]` (empty target) resolves to the linking document; backlinks and
  the graph leave that self link out.
- **A line that arrives before the text waits for it.** The window gets the
  line of a `[[file#heading]]` link (`jump-to-line`) when the tab of the
  file exists; the editor of the tab gets the text of the file later. A pane
  whose editor has no document keeps the line (`pendingJumpLine`,
  `MainEditor.vue`) and jumps when its load ended; a jump in an editor
  without the text finds no such line and leaves the cursor on line 1.
  Proof: `e2e/jump-to-heading-while-loading.spec.ts` (a document of 15,000
  lines, by a Mod-click and by the key of "Follow link").
- **One reading of a link.** A wikilink is a `ZettelkastenLink` of the Markdown
  AST, read with the setting `zkn.linkFormat`: in `[[a|b]]` the target is `a`
  for `link|title` and `b` for `title|link`, and `[[x]]` in code is no link.
  Each reader parses with that format (`markdownToAST(text, null, linkFormat)`)
  or uses the tree of the editor, which has it: the FSAL file parser, the
  editor chips, the lint context (`WikilinkReading`: the index and the
  format), the export map and the rewrite after a move. No reader finds
  wikilinks with a regular expression. A change of the setting needs a
  restart: the FSAL reads the links of each file at the start. Proof:
  `test/wikilink-reading.spec.ts`, `e2e/wikilinks-title-first.spec.ts`.
- **Editor chips:** the renderer bundle has no `path`, so the editor cannot run
  `WikilinkIndex`. `MainEditor.vue` sends the document's targets to the IPC
  command `resolve-wikilinks` and stores the answer in
  `wikilinkResolutionsField` (`markdown-editor/plugins/`). `render-wikilinks.ts`
  draws a link that resolves to one document as a chip; an ambiguous or missing
  link stays raw text, and Flowmark reports it. Mod-click on a chip opens it.
- **Lint:** Zettlr sends `wikilinks.resolutions` in the Flowmark context
  (`flowmark-lint-context.ts`); the rules `link/missing-wikilink-target`,
  `link/ambiguous-wikilink` and `link/relative-wikilink` live in pandoc-flowmark.
  The lint cache key includes those resolutions, so a rename elsewhere refreshes
  the diagnostics of the documents it affects.
- **YAML `aliases`** is parsed by `fsal/util/file-parser.ts`. A change to what the
  parser extracts must bump `PARSER_VERSION` in that file. A descriptor keeps
  the identity of its parser (`parsedWith`: the version, `zkn.idRE` and
  `zkn.linkFormat`); a cached descriptor of another parser is parsed again.
- **Exports:** each export that runs Pandoc writes `wikilinkExportMap`
  (`common/util/wikilink-export.ts`) through `withWikilinkMap`
  (`exporter/wikilink-map-file.ts`): the heading count of each input and, per
  raw target, the input and heading it resolves to. `PANDOC_WIKILINKS` names
  that file. The PDF recipe runs `filters/wikilinks.lua` of pandoc-config
  itself; a Pandoc profile (`makeExport`: LaTeX, Word, HTML, a script) runs
  `~/.pandoc/filters/wikilinks.lua` before each other filter. The filter
  turns each resolved link into a link to that heading and any other link into
  its label; it resolves nothing itself. A link to a document outside the
  export is its label. Proof: `test/export-document.spec.ts`.
- **Renderer imports:** `wikilink-resolution.ts` imports Node `path`, which
  the renderer bundle maps to an empty module. Editor and window code import
  `splitWikilinkTarget` and `wikilinkTargetsIn` from
  `common/util/wikilink-target.ts`, which imports only `markdown-utils`, and
  ask the main process for resolutions.
