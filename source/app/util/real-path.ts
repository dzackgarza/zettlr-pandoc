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

import { existsSync, realpathSync } from 'fs'

/**
 * Resolves a path to the file it names. A path that names nothing yet — a
 * chapter the author has not written — keeps the path it was given.
 *
 * @param   {string}  absolutePath  The path to resolve
 *
 * @return  {string}                The real path, or the given path
 */
export function resolveRealPath (absolutePath: string): string {
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath
}
