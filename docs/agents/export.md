# 3. PDF export → the `~/.pandoc` `compile-pandoc` recipe

- **`~/.pandoc` is a plain directory whose `justfile` and `filters/*` are symlinks
  into a checkout of `dzackgarza/pandoc-config`** (currently the vendor submodule at
  `~/pandoc-preview-greenfield2/src-tauri/resources/vendor/pandoc-config`; a
  development clone lives at `~/gitclones/pandoc-config`). That `justfile` is the
  **authoritative contract** for PDF conventions (filters, flags, engine). Read it
  before reverse-engineering export behavior.
- **PDF export delegates** to that recipe — the app owns no pandoc/LaTeX flags:
  `source/app/service-providers/commands/exporter/recipe-exporter.ts` runs
  `just --justfile ~/.pandoc/justfile compile-pandoc <file> <title> [<template>]`
  for single files, and `compile-pandoc-project <title> <template> <files…>` for
  ordered Project exports (issue #1).
  PDF is an **export item of the application** with the engine `recipe`
  (`exporter/export-items.ts`); dispatch is in `makeExport`. The dzg templates
  require **pdflatex** (xelatex/lualatex fail).
- **The recipe gets the bibliography of the documents.** The run sets
  `PANDOC_BIB_SOURCE` to the files of the bibliography of each input
  (`documentBibliography`, [§12](citations.md)), apart by `:`, without repeats; the main
  library is `export.cslLibrary`. An empty value is an export without a
  bibliography; the recipe reads `ZOTERO_GLOBAL_BIB` only when the variable
  is not set. A file whose path holds `:` refuses the export. Proof:
  `test/export-bibliography.spec.ts` (the real recipe, pdflatex and biber).
- **The templates of a Project go before the settings.** `templateOf`
  (`commands/dir-project-export.ts`) gives an export profile the LaTeX
  template of the Project when its writer is the PDF recipe or a TeX writer
  (`isTexWriter`), and the HTML template of the Project when its writer is an
  HTML writer (`isHtmlWriter`). `makeExport` gives the recipe that template;
  an export without one gets `export.latexTemplate`. Proof:
  `test/project-export.spec.ts`.
- **An export of unsaved text is an export of the document.** A
  `MinimalFile` (`exporter/types.d.ts`) has `path`, the document, and
  `textFile`, the file with the text. `exportDocument` (`commands/export.ts`)
  writes unsaved text to a directory of its own and removes it after the
  export. The recipe runs in the folder of the document and gets the text
  file by its absolute path; a textbundle takes its images from the folder of
  the document; a wikilink resolves to the document. A declared
  `pandoc_working_dir` is read from the folder of the document, and one that
  is no folder refuses the export. A citation library or style of the
  settings or of the Project that is no file refuses the export
  (`writeDefaults`). Proof: `test/export-document.spec.ts`,
  `test/project-export.spec.ts`.
- The Chromium "Simple PDF" export was removed; every export now goes through pandoc.
- **Proof through the window.** `e2e/pdf-export.spec.ts` exports with the real
  recipe, pandoc and pdflatex: the active document from the PDF row of the
  export launcher, and a Project from "Export Project" in the menu of its
  folder. It reads the text of each PDF (`pdftotext`), so the chapters are
  proven in the order of the Project, and it shows the error window and the
  log entry of a recipe that fails. The recipe runs latexmk in force mode: a
  TeX error in a document does not fail it, so the spec forces the failure
  with a template that the recipe does not have.
- **A PDF with TeX errors is exported, and the author gets the errors.** For
  a document with a TeX error that still gives a PDF, the recipe keeps the
  PDF, prints `latexmk exited N but PDF was produced` and ends with exit
  code 0 (`_compile-pandoc-latexmk`). The recipe decides that the PDF stays,
  so the export completes and opens the file. `runRecipeExport` reads the
  errors of TeX from the output of such a run (`texErrorsOfRecipeRun`,
  `exporter/tex-errors.ts`) into `ExporterOutput.texErrors`, each error one
  time. With such errors the export of a document and of a Project opens one
  error window ("The PDF has TeX errors") with the PDF and each error, and
  shows no message of a clean export; a Project names such a profile in the
  one window of a profile that did not export. An export does not read exit
  code 0 of the recipe alone as a PDF without a fault. Proof:
  `test/export-tex-errors.spec.ts`, `test/export-document.spec.ts`,
  `test/project-export.spec.ts`, and with the real recipe
  `e2e/pdf-export.spec.ts`.
- **One list of export items.** An export item is one thing that an author
  exports with (`exporter/export-items.ts`). It has one engine: a Pandoc
  defaults file, the PDF recipe, a bundle writer (Textbundle, Textpack), or a
  command of the author; an item with a Pandoc engine can run a command on
  the file that Pandoc wrote. `exportItems` makes the one list from the
  defaults files of `userData/defaults`, the items of the application and the
  items of the settings (`export.items`: name, base, command, extension), and
  gives each item that cannot run its reason. An item of the application
  replaces a defaults file of its name, so an old `PDF.yaml` there does not
  replace the PDF recipe. The launcher, the Project window and the
  Preferences (`list-export-items`), the Project export
  (`AssetsProvider.listExportItems`) and `just export-headless` read it.
- **A window names an item; the main process resolves it.** The command
  `export` takes `{file, item, exportTo}` with the identity of the item, and
  a Project stores identities in `project.profiles`. No window sends a
  profile object. An entry of a Project file from before the export items is
  the command line of a command; `exportItemOfProjectEntry` still finds its
  item. `makeExport` chooses the exporter by the engine of the item; a
  command runs through it as each other item does, gets the document or the
  folder of the Project as its one argument, and names no file that it wrote
  (`ExporterOutput.targetFile` is null).
- **One place decides what an export runs, and a window shows it.**
  `exporter/resolve-export.ts` decides the effective filter chain (the
  wikilink filter of ~/.pandoc, the filters of the settings, the filters of
  the defaults file), the effective template (the Project, then the defaults
  file, then the setting for the family of the writer) and the effective
  citation style (the Project, then the setting). `writeDefaults` calls
  those functions, and `resolveExport` puts the same decisions into one
  record (`ResolvedExport`) with each stage, who gives the math, and the
  recipe or the command. The launcher shows the record on a line below each
  export item and the Project window shows it in its list with the templates
  and the style of the Project (`resolve-exports`,
  `describeResolvedExport`); each export writes it to the log
  (`[Export] <item> runs:`). `projectOverride` is what an export of a
  Project sets for an item: the export and the window use it. A new
  decision about what an export runs goes into this module, so that the
  record of a window stays what runs. Proof: `test/export-resolved.spec.ts`,
  `test/export-filters.spec.ts`, `e2e/window-header.spec.ts`,
  `e2e/pdf-export.spec.ts`.
- **The settings of an older version become items.** `migrateExportItems`
  (`config/migrate-export-items.ts`) makes items of `export.customCommands`
  (no base) and `export.scripts` (the base is the profile) when the
  configuration is read. Proof: `test/export-items.spec.ts`,
  `test/project-export.spec.ts`, `test/export-document.spec.ts`; through the
  window `e2e/pdf-export.spec.ts`, `e2e/window-header.spec.ts`, and
  `e2e/project-export-failure.spec.ts` with a configuration in the old form.
