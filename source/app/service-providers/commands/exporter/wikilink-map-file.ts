/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        withWikilinkMap
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Writes the wikilink resolutions of the files of an export
 *                  for pandoc-config's filters/wikilinks.lua, which reads the
 *                  file that PANDOC_WIKILINKS names.
 *
 * END HEADER
 */

import { type ExportInput, wikilinkExportMap } from "@common/util/wikilink-export";
import type { WikilinkIndex } from "@common/util/wikilink-resolution";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { MinimalFile } from "./types";

/**
 * Reads the text of each file of an export. The text is that of its
 * `textFile`; a link resolves from the document `path`.
 */
export async function exportInputs(sourceFiles: MinimalFile[]): Promise<ExportInput[]> {
  return await Promise.all(
    sourceFiles.map(async (file) => ({
      path: file.path,
      markdown: await fs.readFile(file.textFile, "utf8"),
    })),
  );
}

/**
 * Writes the wikilink resolutions of `inputs` to a file, runs `run` with the
 * path of that file, and removes the file afterwards.
 */
export async function withWikilinkMap<T>(
  inputs: ExportInput[],
  wikilinks: WikilinkIndex,
  run: (mapFile: string) => Promise<T>,
): Promise<T> {
  const mapDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zettlr-wikilinks-"));
  const mapFile = path.join(mapDirectory, "wikilinks.json");
  await fs.writeFile(mapFile, JSON.stringify(wikilinkExportMap(inputs, wikilinks)), "utf8");
  try {
    return await run(mapFile);
  } finally {
    await fs.rm(mapDirectory, { recursive: true, force: true });
  }
}
