/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        resolveRealPath
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A file's identity is its real path. A Quarto book assembles
 *                  its chapters as symlinks beside its manifest, so the same
 *                  file is reachable under two names, and only the real one
 *                  may reach the document model.
 *
 * END HEADER
 */

import { hasErrnoCode } from "@common/util/is-errno-exception";
import { existsSync, promises as fs, realpathSync } from "fs";
import path from "path";

/**
 * Resolves a path to the file it names. A path that names nothing yet — a
 * chapter the author has not written — keeps the path it was given.
 *
 * @param   {string}  absolutePath  The path to resolve
 *
 * @return  {string}                The real path, or the given path
 */
export function resolveRealPath(absolutePath: string): string {
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

/**
 * The path of `filePath` with each symbolic link resolved. A path that does
 * not exist (a removed file that a document still holds, a new entry) is
 * the real path of its nearest existing folder joined with the rest of the
 * path. Each other failure of the filesystem rejects.
 */
export async function canonicalPath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if (!hasErrnoCode(error, "ENOENT", "ENOTDIR") || parent === absolute) {
      throw error;
    }
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}
