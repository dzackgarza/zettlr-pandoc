/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        enumLangFiles
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This utility function returns a list of all available
 *                  translations, both provided by the app and available in the
 *                  "lang" directory in the user data. Translations in the
 *                  userData have higher priority since these also contain updates.
 *
 * END HEADER
 */

import * as bcp47 from "bcp-47/index.js";
import { app } from "electron";
import fs from "fs";
import path from "path";
import { type Candidate } from "./find-lang-candidates";
import isFile from "./is-file";

export interface LangFileMetadata {
  path: string;
}

/**
 * The directories of the translations in the packaged app: the translations
 * of the user, and then the ones that the build puts beside the bundle.
 */
export function installedTranslationDirectories(): string[] {
  return [path.join(app.getPath("userData"), "/lang"), path.join(__dirname, "/lang")];
}

/**
 * The language tag of a translation file: a PO file whose name without the
 * extension is a BCP 47 tag with a language (`fr-CA.po`). Any other file is
 * no translation, and gives undefined.
 *
 * @param   {string}  file  The name of the file
 *
 * @return  {string|undefined}  The language tag of the file
 */
export function translationTag(file: string): string | undefined {
  if (path.extname(file) !== ".po") {
    return undefined;
  }
  const schema = bcp47.parse(path.basename(file, ".po"));
  const tag = bcp47.stringify(schema);
  return schema.language !== null && schema.language !== undefined ? tag : undefined;
}

/**
 * Enumerates all language files available to load, based on the given search paths.
 * @param  {Array} [paths=[]] An array of paths to search for. Optional.
 * @return {Array}       An array containing metadata for all found files.
 */
export default function enumLangFiles(
  paths = installedTranslationDirectories(),
): Array<Candidate & LangFileMetadata> {
  // Now go through all search paths and enumerate all available files of interest
  const candidates = [];
  for (const p of paths) {
    for (const file of fs.readdirSync(p)) {
      const tag = translationTag(file);
      if (tag !== undefined && isFile(path.join(p, file))) {
        candidates.push({ tag, path: path.join(p, file) });
      }
    }
  }
  return candidates;
}
