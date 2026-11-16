/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Default exporter plugin
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This plugin facilitates exports in most formats Pandoc supports.
 *
 * END HEADER
 */

import { WRITER2EXT } from "@common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "@common/pandoc-util/parse-reader-writer";
import path from "path";
import sanitize from "sanitize-filename";
import type { ExporterAPI, ExporterOptions, ExporterOutput, ExporterPlugin } from "./types";

export const plugin: ExporterPlugin = async function (
  options: ExporterOptions,
  sourceFiles: string[],
  ctx: ExporterAPI,
): Promise<ExporterOutput> {
  const { engine } = options.item;
  if (engine.kind !== "pandoc") {
    throw new Error(`The Pandoc exporter cannot run the export item "${options.item.id}".`);
  }

  const parsedWriter = parseReaderWriter(engine.writer).name;
  const extension = WRITER2EXT[parsedWriter] ?? parsedWriter;

  // First file determines the name of the exported file.
  const firstName = path.basename(options.sourceFiles[0].name, options.sourceFiles[0].ext);
  const title =
    options.defaultsOverride?.title !== undefined
      ? sanitize(options.defaultsOverride.title, { replacement: "-" })
      : firstName;
  const target = path.join(options.targetDirectory, `${title}.${extension}`);

  const defaultKeys = {
    "input-files": sourceFiles,
    "output-file": target,
  };
  const defaultsFile = await ctx.writeDefaults(engine.defaultsFile, defaultKeys);

  // Run Pandoc
  const pandocOutput = await ctx.runPandoc(defaultsFile);

  // Make sure to propagate the results
  return {
    code: pandocOutput.code,
    stdout: pandocOutput.stdout,
    stderr: pandocOutput.stderr,
    targetFile: target,
    texErrors: [],
  };
};
