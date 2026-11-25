# 20. File import

- **An import replaces no file.** `makeImport` (`commands/importer/index.ts`)
  puts each file into the import folder under a name that the folder does
  not have. `placeFile` (`importer/place-file.ts`) copies with
  `COPYFILE_EXCL`, so a file that appears between the check and the copy is
  kept too. A new import path places its files through `placeFile`.
- **Each file has a result.** `makeImport` answers one `ImportOutcome` for
  each file: `imported`, or a refusal with its cause (`destination-exists`,
  `source-missing`, `unknown-format`, `no-profile`, `malformed-bundle`,
  `conversion-failed`, `filesystem-error`). One refused file does not stop
  the other files of the list.
- **A bundle that would replace a file is refused whole.** A TextBundle or
  a TextPack is refused when the folder has its note or one of its `assets/`
  files. The importer examines every destination before the first copy. The
  note of a TextPack takes the name of the pack file.
- **Pandoc writes to a scratch directory.** `convertFile` gives pandoc a
  directory of its own for the defaults file and the output, and places the
  output afterwards. The cause of a failed conversion has the exit code and
  the error output of pandoc. `runPandoc` (`app/util/run-pandoc.ts`) is the
  one start of pandoc for the importer and the exporter.
- **The command shows the refusals once.** `import-files` throws one error
  that names each file that was not imported with its cause; the dispatcher
  shows it ([§15](failed-commands.md)). A cancelled dialog is a choice and shows nothing.
- **Proof:** `test/import-files.spec.ts`, `e2e/import-files.spec.ts`.
