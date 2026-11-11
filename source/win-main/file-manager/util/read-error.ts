/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The mark of a file whose text could not be read
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A file that the filesystem refuses to read has a
 *                  descriptor with the cause. The rows of the file manager
 *                  show that cause with these two functions.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { AnyDescriptor, FileReadError } from "@dts/common/fsal";

/** Why the last read of the text of an item failed, when it failed. */
export function readErrorOf(item: AnyDescriptor): FileReadError | undefined {
  return item.type === "file" || item.type === "code" ? item.readError : undefined;
}

/** The sentence that a row shows for the cause. */
export function readErrorSentence(error: FileReadError): string {
  return trans("Could not read this file: %s", error.message);
}
