/**
 * BEGIN HEADER
 *
 * Contains:        Path examination
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one place that asks the filesystem what is at a path
 *                  and tells "nothing is there" from "no answer". `isFile`,
 *                  `isDir`, `resolvesToFile` and the FSAL predicates are
 *                  built on it.
 *
 * END HEADER
 */

import { lstatSync, type Stats, statSync } from "fs";
import isErrnoException, { hasErrnoCode } from "./is-errno-exception";

/**
 * What the filesystem said about a path. `stats` is undefined when nothing is
 * at the path. `examined: false` carries the error that kept the filesystem
 * from an answer.
 */
export type PathExamination =
  | { examined: true; stats: Stats | undefined }
  | { examined: false; error: NodeJS.ErrnoException };

/**
 * Asks the filesystem what is at a path.
 *
 * @param   {string}           absPath         The path
 * @param   {boolean}          followSymlinks  Whether a symbolic link answers
 *                                             for its target (`stat`) or for
 *                                             itself (`lstat`)
 *
 * @return  {PathExamination}                  The answer, or the error
 */
export function examinePath(absPath: string, followSymlinks: boolean): PathExamination {
  // Node reports each stat failure as an exception, and `throwIfNoEntry`
  // covers ENOENT only for `lstat`. This catch is the boundary that turns
  // the system error into a value.
  try {
    return { examined: true, stats: followSymlinks ? statSync(absPath) : lstatSync(absPath) };
  } catch (error) {
    // A missing entry, and a path below something that is not a directory:
    // nothing is at the path.
    if (hasErrnoCode(error, "ENOENT", "ENOTDIR")) {
      return { examined: true, stats: undefined };
    }
    if (isErrnoException(error)) {
      return { examined: false, error };
    }
    throw error;
  }
}

/**
 * The stats of a path, or undefined when nothing is at the path. Throws the
 * system error when the filesystem could not examine the path.
 */
export function statPath(absPath: string, followSymlinks: boolean): Stats | undefined {
  const examination = examinePath(absPath, followSymlinks);
  if (!examination.examined) {
    throw examination.error;
  }
  return examination.stats;
}
