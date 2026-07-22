/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Canonical pandoc-config recipe exporter
 * CVM-Role:        Controller
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Delegates PDF export to the authoritative ~/.pandoc
 *                  `compile-pandoc` just recipe (pandoc md->tex + latexmk -pdf,
 *                  with pandoc-config's own filters, flags, bibliography, and
 *                  engine). The app owns none of the pandoc/LaTeX pipeline:
 *                  ~/.pandoc/justfile is the single source of truth, so exports
 *                  match what `just pandoc::compile-pandoc` produces on the CLI.
 *
 * END HEADER
 */

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import sanitize from 'sanitize-filename'
import type { ExporterOptions, ExporterOutput } from './types'
import { runShellCommand } from './run-shell-command'
import { splitLines } from './split-lines'

// The canonical recipe file. compile-pandoc has no internal `pandoc::` module
// reference, so it is invocable directly via --justfile without a project
// justfile declaring `mod pandoc`.
const JUSTFILE = path.join(os.homedir(), '.pandoc', 'justfile')

/**
 * Exports the source Markdown to PDF by delegating to the pandoc-config
 * `compile-pandoc` recipe.
 *
 * @param   options        The exporter options (source files, target dir).
 * @param   latexTemplate  The configured LaTeX template (export.latexTemplate);
 *                         empty string lets the recipe use its own default.
 */
export async function runRecipeExport (
  options: ExporterOptions,
  latexTemplate: string
): Promise<ExporterOutput> {
  const source = options.sourceFiles[0]
  // The recipe uses invocation_directory() as its ROOT and resolves the
  // document's relative \input sections and figures against it, so it must run
  // in the source file's own directory.
  const sourceDir = path.dirname(source.path)
  const sourceBase = path.basename(source.path)
  const title = options.defaultsOverride?.title !== undefined
    ? sanitize(options.defaultsOverride.title, { replacement: '-' })
    : path.basename(source.name, source.ext)

  const target = path.join(options.targetDirectory, `${title}.pdf`)

  // Override ONLY what the app owns: the input file, the output base name, and
  // the template when one is configured. Bibliography, build dir, filters,
  // flags, and pdf-engine all come from the recipe's own defaults.
  const argv = [ '--justfile', `'${JUSTFILE}'`, 'compile-pandoc', `'${sourceBase}'`, `'${title}'` ]
  if (latexTemplate.trim() !== '') {
    argv.push(`'${latexTemplate}'`)
  }

  const result = await runShellCommand('just', argv, sourceDir)

  // The recipe writes `<title>-<DD-MM-YY>.pdf` into the source dir (its ROOT).
  // Find the newest such file rather than reconstructing the date string.
  let produced: string | undefined
  let newest = -Infinity
  for (const entry of await fs.readdir(sourceDir)) {
    if (!entry.startsWith(`${title}-`) || !entry.endsWith('.pdf')) {
      continue
    }
    const full = path.join(sourceDir, entry)
    const stat = await fs.stat(full)
    if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs
      produced = full
    }
  }

  if (result.code !== 0 || produced === undefined) {
    return {
      code: result.code !== 0 ? result.code : 1,
      stdout: splitLines(result.stdout),
      stderr: splitLines(result.stderr).concat(
        produced === undefined ? [ 'compile-pandoc did not produce a PDF' ] : []
      ),
      targetFile: target
    }
  }

  // Deliver the PDF to the export target and remove the recipe's dated copy from
  // the source directory (the recipe's own build dir / global.bib symlink are
  // left in place, exactly as a direct `just compile-pandoc` run leaves them).
  await fs.copyFile(produced, target)
  await fs.rm(produced, { force: true })

  return {
    code: 0,
    stdout: splitLines(result.stdout),
    stderr: splitLines(result.stderr),
    targetFile: target
  }
}
