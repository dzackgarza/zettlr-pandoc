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

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import sanitize from "sanitize-filename";
import { runProcess } from "./run-shell-command";
import { splitLines } from "./split-lines";
import type { ExporterOptions, ExporterOutput } from "./types";

// The canonical recipe file. compile-pandoc has no internal `pandoc::` module
// reference, so it is invocable directly via --justfile without a project
// justfile declaring `mod pandoc`.
const JUSTFILE = path.join(os.homedir(), ".pandoc", "justfile");

/**
 * Exports the source Markdown to PDF by delegating to the pandoc-config
 * `compile-pandoc` recipe (single file) or the companion
 * `compile-pandoc-project` recipe (ordered Project inputs, issue #1 Phase 7).
 *
 * @param   options        The exporter options (source files, target dir).
 * @param   latexTemplate  The configured LaTeX template (export.latexTemplate);
 *                         empty string lets the recipe use its own default.
 */
export async function runRecipeExport(
  options: ExporterOptions,
  latexTemplate: string,
): Promise<ExporterOutput> {
  const source = options.sourceFiles[0];
  const isProjectExport = options.sourceFiles.length > 1;
  const title =
    options.defaultsOverride?.title !== undefined
      ? sanitize(options.defaultsOverride.title, { replacement: "-" })
      : path.basename(source.name, source.ext);

  const target = path.join(options.targetDirectory, `${title}.pdf`);

  // Both recipes use invocation_directory() as their ROOT: the single-file
  // recipe resolves the document's relative \input sections and figures
  // against the source file's own directory; the Project recipe runs in the
  // Project root, against which the ordered project-relative inputs resolve.
  let runDir: string;
  let argv: string[];
  if (isProjectExport) {
    if (options.cwd === undefined) {
      throw new Error("Cannot export Project: no Project root was provided (options.cwd)");
    }
    runDir = options.cwd;
    // The ordered inputs, exactly as dir-project-export.ts builds them from
    // ProjectSettings.files: project-relative, Unix separators, in
    // ProjectSettings order. The argv is a LITERAL vector (shell: false,
    // review B2): every token — spaces, quotes, and all — arrives at the
    // recipe as exactly one argument, with no quoting layer to break.
    const orderedInputs = options.sourceFiles.map((file) =>
      path.relative(runDir, file.path).split(path.sep).join("/"),
    );
    // compile-pandoc-project's template parameter is positional BEFORE the
    // variadic input list, so it cannot be omitted the way compile-pandoc's
    // trailing template can. An unconfigured template passes the companion's
    // '' sentinel (review B11): the recipe maps ''/'-' to its own
    // DEFAULT_TEMPLATE, so the default template name lives in exactly one
    // repository.
    argv = [
      "--justfile",
      JUSTFILE,
      "compile-pandoc-project",
      title,
      latexTemplate.trim(),
      ...orderedInputs,
    ];
  } else {
    runDir = path.dirname(source.path);
    const sourceBase = path.basename(source.path);
    // Override ONLY what the app owns: the input file, the output base name,
    // and the template when one is configured. Bibliography, build dir,
    // filters, flags, and pdf-engine all come from the recipe's own defaults.
    argv = ["--justfile", JUSTFILE, "compile-pandoc", sourceBase, title];
    if (latexTemplate.trim() !== "") {
      argv.push(latexTemplate.trim());
    }
  }

  const result = await runProcess("just", argv, runDir);

  // The recipe writes `<title>-<DD-MM-YY>.pdf` into its ROOT (runDir).
  // Find the newest such file rather than reconstructing the date string.
  let produced: string | undefined;
  let newest = -Infinity;
  for (const entry of await fs.readdir(runDir)) {
    if (!entry.startsWith(`${title}-`) || !entry.endsWith(".pdf")) {
      continue;
    }
    const full = path.join(runDir, entry);
    const stat = await fs.stat(full);
    if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
      produced = full;
    }
  }

  if (result.code !== 0 || produced === undefined) {
    return {
      code: result.code !== 0 ? result.code : 1,
      stdout: splitLines(result.stdout),
      stderr: splitLines(result.stderr).concat(
        produced === undefined ? ["compile-pandoc did not produce a PDF"] : [],
      ),
      targetFile: target,
    };
  }

  // Deliver the PDF to the export target and remove the recipe's dated copy from
  // the source directory (the recipe's own build dir / global.bib symlink are
  // left in place, exactly as a direct `just compile-pandoc` run leaves them).
  await fs.copyFile(produced, target);
  await fs.rm(produced, { force: true });

  return {
    code: 0,
    stdout: splitLines(result.stdout),
    stderr: splitLines(result.stderr),
    targetFile: target,
  };
}
