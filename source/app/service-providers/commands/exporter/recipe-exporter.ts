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
 *                  with pandoc-config's own filters, flags and engine). The
 *                  app gives the recipe the inputs, the title, the template,
 *                  the wikilink resolutions and the bibliography of the
 *                  documents. It owns none of the pandoc/LaTeX pipeline:
 *                  ~/.pandoc/justfile is the single source of truth, so exports
 *                  match what `just pandoc::compile-pandoc` produces on the CLI.
 *
 * END HEADER
 */

import type { WikilinkReading } from "@common/util/wikilink-resolution";
import type FSAL from "@providers/fsal";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import sanitize from "sanitize-filename";
import { bibliographyFiles, documentBibliography } from "../../../util/document-bibliographies";
import { runProcess } from "./run-shell-command";
import { splitLines } from "./split-lines";
import type { ExporterOptions, ExporterOutput, MinimalFile } from "./types";
import { exportInputs, withWikilinkMap } from "./wikilink-map-file";

// The canonical recipe file. compile-pandoc has no internal `pandoc::` module
// reference, so it is invocable directly via --justfile without a project
// justfile declaring `mod pandoc`.
const JUSTFILE = path.join(os.homedir(), ".pandoc", "justfile");

/**
 * The input argument of a recipe for one document. The recipe runs in
 * `runDir` and reads a relative input from there: a document whose text is on
 * disk is the path from `runDir`, with Unix separators. Unsaved text is in a
 * file elsewhere, which the recipe gets by its absolute path; the relative
 * resources of the document still resolve against `runDir`.
 */
function recipeInput(file: MinimalFile, runDir: string): string {
  if (file.textFile !== file.path) {
    return file.textFile;
  }
  return path.relative(runDir, file.path).split(path.sep).join("/");
}

/** What the app gives a recipe run beside its inputs. */
export interface RecipeContext {
  /**
   * The LaTeX template of the export: that of the Project, else the setting
   * export.latexTemplate. An empty string lets the recipe use its own default.
   */
  latexTemplate: string;
  /** How the workspace reads and resolves the wikilinks. */
  wikilinks: WikilinkReading;
  /** The folders of the documents, for their Projects. */
  fsal: Pick<FSAL, "getAnyDirectoryDescriptor">;
  /** The main library: the setting export.cslLibrary. */
  mainLibrary: string;
}

/**
 * The value of PANDOC_BIB_SOURCE for the inputs: the files of the
 * bibliography of each input, as the editor has it (#198), in the order of
 * the inputs and without repeats, apart by ':'. An empty value is an export
 * without a bibliography.
 */
async function recipeBibliography(
  inputs: Array<{ path: string; markdown: string }>,
  context: RecipeContext,
): Promise<string> {
  const files: string[] = [];
  for (const input of inputs) {
    const { database } = await documentBibliography(context.fsal, input.path, input.markdown);
    for (const file of bibliographyFiles(database, context.mainLibrary)) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }
  const separated = files.find((file) => file.includes(":"));
  if (separated !== undefined) {
    throw new Error(
      `Cannot give the bibliography ${separated} to the PDF recipe: its path holds ":", which separates the files of PANDOC_BIB_SOURCE`,
    );
  }
  return files.join(":");
}

/**
 * Exports the source Markdown to PDF by delegating to the pandoc-config
 * `compile-pandoc` recipe (single file) or the companion
 * `compile-pandoc-project` recipe (ordered Project inputs, issue #1 Phase 7).
 *
 * @param   options  The exporter options (source files, target dir).
 * @param   context  The template, the wikilinks and the bibliography sources.
 */
export async function runRecipeExport(
  options: ExporterOptions,
  context: RecipeContext,
): Promise<ExporterOutput> {
  const { latexTemplate, wikilinks } = context;
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
      throw new Error("Cannot export the Project because its folder was not provided");
    }
    runDir = options.cwd;
    // The ordered inputs, exactly as dir-project-export.ts builds them from
    // ProjectSettings.files: project-relative, Unix separators, in
    // ProjectSettings order. The argv is a LITERAL vector (shell: false,
    // review B2): every token — spaces, quotes, and all — arrives at the
    // recipe as exactly one argument, with no quoting layer to break.
    const orderedInputs = options.sourceFiles.map((file) => recipeInput(file, runDir));
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
    // The app gives the input file, the output base name, the template when
    // one is configured, and (below) the bibliography. Build dir, filters,
    // flags and pdf-engine come from the recipe.
    argv = ["--justfile", JUSTFILE, "compile-pandoc", recipeInput(source, runDir), title];
    if (latexTemplate.trim() !== "") {
      argv.push(latexTemplate.trim());
    }
  }

  // Zettlr resolves the wikilinks; the recipe's filters/wikilinks.lua reads
  // the resolutions from the file that PANDOC_WIKILINKS names.
  const inputs = await exportInputs(options.sourceFiles);
  // The recipe cites from the bibliography that the editor shows (#198).
  const bibliography = await recipeBibliography(inputs, context);
  const result = await withWikilinkMap(
    inputs,
    wikilinks,
    async (mapFile) =>
      await runProcess("just", argv, runDir, {
        ...process.env,
        PANDOC_WIKILINKS: mapFile,
        PANDOC_BIB_SOURCE: bibliography,
      }),
  );

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
  // the source directory (the build dir of the recipe is
  // left in place, as a direct `just compile-pandoc` run leaves it).
  await fs.copyFile(produced, target);
  await fs.rm(produced, { force: true });

  return {
    code: 0,
    stdout: splitLines(result.stdout),
    stderr: splitLines(result.stderr),
    targetFile: target,
  };
}
