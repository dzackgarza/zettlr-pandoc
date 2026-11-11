/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        readFileText function
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Reads the text of a file for its descriptor. A file that
 *                  is there and that the filesystem refuses to read gives the
 *                  cause as a value: such a file has a descriptor, and the
 *                  index of its workspace goes on.
 *
 * END HEADER
 */

import isErrnoException from "@common/util/is-errno-exception";
import type { FileReadError } from "@dts/common/fsal";
import { promises as fs } from "fs";

/** The codes of a path that is no file: the caller has no descriptor to give. */
const MISSING_PATH_CODES = ["ENOENT", "ENOTDIR"];

/**
 * The text of a file, or the cause when the filesystem refuses the read. A
 * path that is gone rejects, as does a failure that is no filesystem error.
 */
export async function readFileText(filePath: string): Promise<string | FileReadError> {
  return await fs.readFile(filePath, { encoding: "utf8" }).catch((error: unknown) => {
    if (
      !isErrnoException(error) ||
      error.code === undefined ||
      MISSING_PATH_CODES.includes(error.code)
    ) {
      throw error;
    }
    return { code: error.code, message: error.message };
  });
}
