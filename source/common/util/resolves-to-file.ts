/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Symlink-FOLLOWING file check. This is deliberately NOT the
 *                  same predicate as ./is-file.ts: isFile() uses lstatSync and
 *                  reports what the path entry itself is (a symlink is never a
 *                  file), while resolvesToFile() uses statSync and reports
 *                  whether the path RESOLVES to a regular file (a symlink to a
 *                  file counts). Consumers that accept a symlinked target —
 *                  e.g. the boot preflight's ~/.pandoc/justfile requirement —
 *                  need this variant; consumers that must distinguish the link
 *                  entry itself keep isFile().
 *
 * END HEADER
 */

import { statPath } from "./examine-path";

/**
 * True iff `p` resolves to a regular file, following symlinks.
 *
 * @param  {string}  p  The path to check
 *
 * @return {boolean}    True iff the (symlink-resolved) target is a regular file
 * @throws {Error}      If the filesystem could not examine the path
 */
export default function resolvesToFile(p: string): boolean {
  return statPath(p, true)?.isFile() === true;
}
