/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrImport
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The importer module for Zettlr. An import puts new files
 *                  into a folder of the author and replaces no file there.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { EXT2READER, SUPPORTED_READERS } from "@common/pandoc-util/pandoc-maps";
import { hasMarkdownExt } from "@common/util/file-extention-checks";
import type { DirDescriptor } from "@dts/common/fsal";
import type AssetsProvider from "@providers/assets";
import type { ValidPandocProfile } from "@providers/assets";
import { app, dialog } from "electron";
import { promises as fs } from "fs";
import path from "path";
import YAML from "yaml";
import { runPandoc } from "../../../util/run-pandoc";
import { systemErrorCause } from "../../../util/system-error-cause";
import { importTextbundle, importTextpack } from "./import-textbundle";
import {
  destinationExists,
  filesystemFailure,
  type ImportStep,
  isTaken,
  placeFile,
} from "./place-file";

/** The result of the import of one file of a list. */
export type ImportOutcome = ImportStep & { source: string };

/**
 * Imports each file of a list into a folder. A file that is not imported
 * does not stop the files after it.
 *
 * @param   {string[]}        fileList        The files to import
 * @param   {DirDescriptor}   dirToImport     The import folder
 * @param   {AssetsProvider}  assetsProvider  The owner of the import profiles
 *
 * @return  {Promise<ImportOutcome[]>}        One result for each file, in the order of the list
 */
export default async function makeImport(
  fileList: string[],
  dirToImport: DirDescriptor,
  assetsProvider: AssetsProvider,
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const source of fileList) {
    const step = await importFile(source, dirToImport.path, assetsProvider).catch(
      filesystemFailure,
    );
    outcomes.push({ source, ...step });
  }
  return outcomes;
}

/** What is at the path of a file to import. */
async function kindOf(source: string): Promise<"file" | "directory" | "missing"> {
  return await fs.stat(source).then(
    (stats) => (stats.isDirectory() ? "directory" : "file"),
    (failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") {
        return "missing";
      }
      throw failure;
    },
  );
}

async function importFile(
  source: string,
  folder: string,
  assetsProvider: AssetsProvider,
): Promise<ImportStep> {
  const kind = await kindOf(source);
  if (kind === "missing") {
    return { result: "source-missing", cause: trans("the file is not there") };
  }

  const extension = path.extname(source);
  const name = path.basename(source, extension);
  const destination = path.join(folder, `${name}.md`);

  // A TextBundle is a directory.
  if (extension === ".textbundle") {
    return kind === "directory"
      ? await importTextbundle(source, name, folder)
      : { result: "malformed-bundle", cause: trans("the TextBundle is not a folder") };
  }

  if (kind === "directory") {
    return { result: "unknown-format", cause: trans("a folder that is no TextBundle") };
  }

  if (extension === ".textpack") {
    return await importTextpack(source, name, folder);
  }

  if (hasMarkdownExt(source)) {
    return await placeFile(source, folder, destination);
  }

  const readers = EXT2READER[extension.substring(1).toLowerCase()];
  if (readers === undefined) {
    return { result: "unknown-format", cause: trans("no import reads this file type") };
  }

  // The check comes before the conversion, so the author chooses no profile
  // and waits for no pandoc run for a file that is refused.
  if (await isTaken(destination)) {
    return destinationExists(folder, destination);
  }

  return await convertFile(source, folder, destination, readers, assetsProvider);
}

/** Lets the author choose one of several profiles that read a file. */
async function chooseProfile(
  profiles: ValidPandocProfile[],
  fileName: string,
): Promise<ValidPandocProfile> {
  const response = await dialog.showMessageBox({
    title: trans("Select import profile"),
    message: trans("Select import profile"),
    detail: trans("There are multiple profiles that can import %s. Please choose one.", fileName),
    buttons: profiles.map((profile) => `${profile.name} (${profile.writer})`),
    defaultId: 0,
  });
  return profiles[response.response];
}

/**
 * Lets pandoc make Markdown of a file. Pandoc writes to a temporary
 * directory of this conversion, so it replaces nothing in the import folder.
 */
async function convertFile(
  source: string,
  folder: string,
  destination: string,
  readers: string[],
  assetsProvider: AssetsProvider,
): Promise<ImportStep> {
  const profiles = (await assetsProvider.listDefaults())
    .filter((profile): profile is ValidPandocProfile => !profile.isInvalid)
    .filter((profile) => SUPPORTED_READERS.includes(profile.writer))
    .filter((profile) => readers.includes(profile.reader));

  if (profiles.length === 0) {
    return {
      result: "no-profile",
      cause: trans("no import profile reads this file type; create one in the Assets Manager"),
    };
  }

  const profile =
    profiles.length === 1 ? profiles[0] : await chooseProfile(profiles, path.basename(source));
  const defaults = await assetsProvider.getDefaultsFile(profile.name);

  const scratch = await fs.mkdtemp(path.join(app.getPath("temp"), "zettlr-import-"));
  return await convertIn(scratch, source, folder, destination, defaults).finally(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
}

async function convertIn(
  scratch: string,
  source: string,
  folder: string,
  destination: string,
  defaults: Record<string, unknown>,
): Promise<ImportStep> {
  const converted = path.join(scratch, "converted.md");
  const defaultsFile = path.join(scratch, "defaults.yml");
  await fs.writeFile(
    defaultsFile,
    YAML.stringify(
      { ...defaults, "input-files": [source], "output-file": converted },
      { indent: 4, simpleKeys: false },
    ),
    { encoding: "utf8" },
  );

  const refusal = await runPandoc(defaultsFile).then(
    (output): ImportStep | undefined => {
      if (output.code === 0) {
        return undefined;
      }
      return {
        result: "conversion-failed",
        cause: trans("pandoc ended with code %s: %s", output.code, output.stderr.join(" ")),
      };
    },
    (failure: NodeJS.ErrnoException): ImportStep => {
      return {
        result: "conversion-failed",
        cause: trans("pandoc did not start: %s", systemErrorCause(failure)),
      };
    },
  );

  return refusal === undefined ? await placeFile(converted, folder, destination) : refusal;
}
