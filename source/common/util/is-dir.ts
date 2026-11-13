/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a utility function to check a path.
 *
 * END HEADER
 */

import { statPath } from "./examine-path";

/**
 * Checks if a given path is a directory. A symbolic link is not a directory.
 * @param  {string}  p The path to check
 *
 * @return {boolean}   True if a directory is at the path, false if something
 *                     else or nothing is there
 * @throws {Error}     If the filesystem could not examine the path
 */
export default function isDir(p: string): boolean {
  return statPath(p, false)?.isDirectory() === true;
}
