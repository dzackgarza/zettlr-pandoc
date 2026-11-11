/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a utility function to check a file.
 *
 * END HEADER
 */

import { statPath } from "./examine-path";

/**
 * Checks if a given path is a file. A symbolic link is not a file.
 *
 * @param  {string}  p The path to check
 *
 * @return {boolean}   True if a file is at the path, false if something else
 *                     or nothing is there
 * @throws {Error}     If the filesystem could not examine the path
 */
export default function isFile(p: string): boolean {
  return statPath(p, false)?.isFile() === true;
}
