/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pipeline-integrated export script runner
 * CVM-Role:        Controller
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Runs a declared export script: export the source through a
 *                  base Pandoc profile to an intermediate file, then run the
 *                  script command on that Pandoc-processed intermediate. Lets a
 *                  compilation script (latexmk, a converter, a shell pipeline)
 *                  be declared in config as a first-class export Format.
 *
 * END HEADER
 */

import { WRITER2EXT } from "@common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "@common/pandoc-util/parse-reader-writer";
import os from "os";
import path from "path";
import sanitize from "sanitize-filename";
import type { ExportEngine, PostStage } from "./export-items";
import { runShellCommand } from "./run-shell-command";
import { splitLines } from "./split-lines";
import type { ExporterAPI, ExporterOptions, ExporterOutput } from "./types";

/**
 * Runs an export item with a Pandoc engine and a command after it: Pandoc
 * writes an intermediate file with the defaults file of the engine, and the
 * command of the item gets that file and the file to write.
 *
 * @param   {ExporterOptions}  options      The options of the export
 * @param   {string[]}         sourceFiles  The files that hold the text
 * @param   {ExporterAPI}      ctx          Writes the defaults and runs Pandoc
 * @param   {ExportEngine}     engine       The Pandoc engine of the item
 * @param   {PostStage}        post         The command of the item
 */
export async function runScriptExport(
  options: ExporterOptions,
  sourceFiles: string[],
  ctx: ExporterAPI,
  engine: Extract<ExportEngine, { kind: "pandoc" }>,
  post: PostStage,
): Promise<ExporterOutput> {
  const firstName = path.basename(options.sourceFiles[0].name, options.sourceFiles[0].ext);
  const title =
    options.defaultsOverride?.title !== undefined
      ? sanitize(options.defaultsOverride.title, { replacement: "-" })
      : firstName;

  // The extension of the intermediate file follows the writer of the engine.
  const baseWriter = parseReaderWriter(engine.writer).name;
  const intermediateExt = WRITER2EXT[baseWriter] ?? baseWriter;
  const intermediate = path.join(os.tmpdir(), `${title}.intermediate.${intermediateExt}`);

  // 1. Pandoc writes the intermediate file with the defaults file of the engine.
  const defaultsFile = await ctx.writeDefaults(engine.defaultsFile, {
    "input-files": sourceFiles,
    "output-file": intermediate,
  });
  const pandocOutput = await ctx.runPandoc(defaultsFile);
  if (pandocOutput.code !== 0) {
    return {
      code: pandocOutput.code,
      stdout: pandocOutput.stdout,
      stderr: pandocOutput.stderr,
      targetFile: intermediate,
      texErrors: [],
    };
  }

  // 2. The command of the item runs on the file that Pandoc wrote.
  const target = path.join(options.targetDirectory, `${title}.${post.extension}`);
  const cwd = options.cwd ?? path.dirname(intermediate);
  const scriptOutput = await runShellCommand(post.command, [intermediate, target], cwd);

  return {
    code: scriptOutput.code,
    stdout: pandocOutput.stdout.concat(splitLines(scriptOutput.stdout)),
    stderr: pandocOutput.stderr.concat(splitLines(scriptOutput.stderr)),
    targetFile: target,
    texErrors: [],
  };
}
