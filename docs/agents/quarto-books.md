# 4. Quarto books

A directory is a Quarto project when a manifest describes it. Quarto stays the
manifest, render and numbering authority; Zettlr reads the authoring fields.

- **Where the manifest is.** `<dir>/_quarto.yml`, or the file the directory is bound
  to. The binding is `DirectorySettings.quartoManifest`, a path relative to the
  directory, set from the directory properties popover and persisted in
  `.ztr-directory`. It exists because a book may keep its manifest in an assembly
  directory beside the machinery that renders it — `~/research/writing/.book/` — with
  the prose one level up.
- **The project is derived, never stored.** `parseQuartoManifest`
  (`fsal-directory.ts`) rebuilds it from the manifest on every load, and
  `persistSettings` writes only the settings the user authored. `.ztr-directory` may
  name where the manifest is; it must never carry a copy of the order, the chapters or
  the bibliographies, which the manifest owns (#83). A project the user made
  themselves (`manifest.kind === 'zettlr'`) is authored, and is left alone.
- **A chapter's identity is its real path.** `parseQuartoProject`
  (`source/app/util/quarto-project.ts`) resolves each path against the manifest's own
  directory and then through `realpath`, so a symlinked chapter is the file it points
  at and no file reaches the document model under two names. `parseQuartoManifest`
  then names each chapter relative to the real path of the Project directory, so
  `ProjectSettings.files` holds directory-relative paths with `/` separators for a
  Quarto project and for a Zettlr one.
- **A part is a title or a file.** Quarto reads the `part` of a book as a file when
  a file is at that path beside the manifest, and as a title otherwise.
  `quartoPartFile` (`quarto-project.ts`) makes the same decision. A part that a file
  names is a `part-file` navigation item: the file is a document of the book, before
  the chapters of its part in `ProjectSettings.files`, and its title is the title of
  the part. The Book module shows it as a numbered row that opens the file.
- **The Project of a file is the innermost Project directory that holds it.** A
  Project directory is a loaded directory with `settings.project`, at any depth of
  a workspace; the workspace store lists them (`projectDirectories`), and
  `projectRootForPath` (`common/util/explorer-ordering.ts`) decides. A book in a
  subdirectory of a book owns its own chapters.
- **Consumers:** the Book module (`QuartoBookOutline.vue`; `NavigationSidebar.vue`
  shows it when the Project of the active file is a Quarto book), the Explorer
  membership marks, inherited bibliographies
  (`get-bibliography-for-descriptor.ts`), and project export.
- **A new label has the id that Quarto numbers.** In a document of a Quarto
  project, "Create reference label…" makes a figure, table, section, equation
  or listing id with `-` (`sec-x`); a theorem-like id keeps `:` (`thm:x`), which
  the amsthm filters of the book number. `referenceLabelSeparator`
  (`types/common/references.ts`) decides; the command
  `get-cross-reference-system` gives the system of the document. Proof:
  `e2e/quarto-reference-label.spec.ts`.
- **A Book edit changes the manifest on disk.** The command `quarto-book-edit`
  reads the manifest, edits it and writes it ([§16](authored-text-writes.md)). While an editor holds
  unsaved text of the manifest, the command refuses the edit: the edit would
  not hold that text, and a save of the tab would undo the edit. Proof:
  `e2e/quarto-bound-book.spec.ts`.
