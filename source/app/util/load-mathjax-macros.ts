/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        User MathJax macro loader
 * CVM-Role:        Utility
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Loads the user's MathJax macro file from the app config
 *                  directory. The file uses the standard MathJax tex.macros
 *                  JSON shape, so any such export (e.g. a Pandoc macro export)
 *                  can be dropped in or symlinked to integrate a macro set.
 *
 * END HEADER
 */

import isFile from "@common/util/is-file";
import { type MathJaxMacro, parseMathJaxMacros } from "@common/util/mathjax-config";
import { promises as fs } from "fs";
import path from "path";

export const MATHJAX_MACROS_FILENAME = "mathjax-macros.json";

/**
 * Resolves the macro file inside the given config directory (the app's
 * userData directory, which is XDG-compliant on Linux).
 */
export function mathJaxMacrosPath(configDirectory: string): string {
  return path.join(configDirectory, MATHJAX_MACROS_FILENAME);
}

/**
 * Seeds the config directory with the shipped default macro file so a fresh
 * install has a set of standard macros working out of the box, editable in
 * place. Only writes if the user has no macro file yet, so it never clobbers
 * user edits or a symlinked macro set.
 */
export async function seedDefaultMacros(
  configDirectory: string,
  defaultMacrosPath: string,
): Promise<void> {
  const target = mathJaxMacrosPath(configDirectory);
  if (isFile(target)) {
    return;
  }

  await fs.copyFile(defaultMacrosPath, target);
}

/**
 * Reads and validates the user's MathJax macro file. An absent file means the
 * user has no custom macros and yields an empty map; a present but malformed
 * file throws so the failure is visible rather than silently rendering without
 * the macros.
 */
export async function loadMathJaxMacros(filePath: string): Promise<Record<string, MathJaxMacro>> {
  if (!isFile(filePath)) {
    return {};
  }

  const contents = await fs.readFile(filePath, { encoding: "utf8" });
  return parseMathJaxMacros(JSON.parse(contents));
}
