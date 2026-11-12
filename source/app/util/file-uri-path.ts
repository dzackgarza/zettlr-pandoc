/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        filePathOfUri
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The path of a file that a window names by a URI. The
 *                  renderer names a local file with a `safe-file://` URI
 *                  (`makeValidUri`) or a `file://` URI; the path goes to the
 *                  filesystem and to the desktop.
 *
 * END HEADER
 */

import { fileURLToPath } from "node:url";

const SAFE_FILE_PROTOCOL = "safe-file://";

/**
 * The path of the file that a `safe-file://` or `file://` URI names. Node's
 * `fileURLToPath` decodes the percent escapes, removes the query and the
 * fragment, and reads the drive letter of a Windows path.
 *
 * @param   {string}  uri  The URI of a local file
 *
 * @return  {string}       The path of the file
 */
export function filePathOfUri(uri: string): string {
  if (uri.startsWith(SAFE_FILE_PROTOCOL)) {
    return fileURLToPath(`file://${uri.slice(SAFE_FILE_PROTOCOL.length)}`);
  }
  return fileURLToPath(uri);
}
