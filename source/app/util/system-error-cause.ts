/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        systemErrorCause
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The cause of a failed operation, for a message to the
 *                  author.
 *
 * END HEADER
 */

import { getSystemErrorMessage } from "util";

/**
 * What the operating system said about a failed call: "permission denied",
 * "no space left on device". The message of a Node system error has the
 * error code, the call and the paths around those words
 * (https://nodejs.org/api/errors.html#class-systemerror); a message of the
 * app names the file itself. An error that is not a system error gives its
 * message.
 */
export function systemErrorCause(failure: NodeJS.ErrnoException): string {
  return failure.errno === undefined ? failure.message : getSystemErrorMessage(failure.errno);
}
