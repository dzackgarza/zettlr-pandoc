/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Functions that import TextBundles and TextPacks.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import ZIP from "adm-zip";
import { app } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { isTaken } from "../../fsal/util/fs";
import { destinationExists, type ImportStep, placeFile } from "./place-file";

/**
 * Imports a TextBundle: its text becomes `<name>.md` in the folder, and its
 * figures go to the `assets` folder of the folder. The import checks each
 * destination before the first copy, so a bundle that would replace a file
 * leaves the folder as it is.
 *
 * @param   {string}  bundle  The directory of the bundle
 * @param   {string}  name    The name of the new Markdown file, without extension
 * @param   {string}  folder  The import folder
 */
export async function importTextbundle(
  bundle: string,
  name: string,
  folder: string,
): Promise<ImportStep> {
  const entries = await fs.readdir(bundle, { withFileTypes: true });
  // The text of a bundle may have any extension.
  const text = entries.find((entry) => entry.isFile() && entry.name.startsWith("text."));
  if (text === undefined) {
    return { result: "malformed-bundle", cause: trans("the TextBundle has no text file") };
  }

  const assets = entries.find((entry) => entry.isDirectory() && entry.name === "assets");
  if (assets === undefined) {
    return { result: "malformed-bundle", cause: trans("the TextBundle has no assets folder") };
  }

  const figures = (await fs.readdir(path.join(bundle, "assets"), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const destination = path.join(folder, `${name}.md`);
  const assetsFolder = path.join(folder, "assets");
  for (const candidate of [destination, ...figures.map((f) => path.join(assetsFolder, f))]) {
    if (await isTaken(candidate)) {
      return destinationExists(folder, candidate);
    }
  }

  if (figures.length > 0) {
    await fs.mkdir(assetsFolder, { recursive: true });
  }

  for (const figure of figures) {
    const placed = await placeFile(
      path.join(bundle, "assets", figure),
      folder,
      path.join(assetsFolder, figure),
    );
    if (placed.result !== "imported") {
      return placed;
    }
  }

  return await placeFile(path.join(bundle, text.name), folder, destination);
}

/**
 * Imports a TextPack, the ZIP archive of a TextBundle. The archive is
 * unpacked to a temporary directory of its own, which is removed afterwards.
 *
 * @param   {string}  pack    The archive
 * @param   {string}  name    The name of the new Markdown file, without extension
 * @param   {string}  folder  The import folder
 */
export async function importTextpack(
  pack: string,
  name: string,
  folder: string,
): Promise<ImportStep> {
  const scratch = await fs.mkdtemp(path.join(app.getPath("temp"), "zettlr-import-"));
  return await importUnpacked(pack, scratch, name, folder).finally(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
}

async function importUnpacked(
  pack: string,
  scratch: string,
  name: string,
  folder: string,
): Promise<ImportStep> {
  // adm-zip throws for a file that is no ZIP archive.
  const notUnpacked = await Promise.resolve()
    .then(() => {
      new ZIP(pack).extractAllTo(scratch, true);
    })
    .then(
      () => undefined,
      (failure: Error) => failure.message,
    );
  if (notUnpacked !== undefined) {
    return {
      result: "malformed-bundle",
      cause: trans("the TextPack could not be unpacked: %s", notUnpacked),
    };
  }

  // An archive holds the bundle directory, or the content of the bundle
  // without that directory.
  const unpacked = await fs.readdir(scratch, { withFileTypes: true });
  const directory = unpacked.find(
    (entry) => entry.isDirectory() && path.extname(entry.name) === ".textbundle",
  );
  const bundle = directory === undefined ? scratch : path.join(scratch, directory.name);
  return await importTextbundle(bundle, name, folder);
}
