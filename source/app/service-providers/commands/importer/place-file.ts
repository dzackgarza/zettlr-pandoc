/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Import steps
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The result of the import of one file, and the one way in
 *                  which an import puts a file into the folder of the author.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { constants as FS_CONSTANTS, promises as fs } from "fs";
import path from "path";
import { systemErrorCause } from "../../../util/system-error-cause";

/** Why a file was not imported. */
export type ImportRefusal =
  | "destination-exists"
  | "source-missing"
  | "unknown-format"
  | "no-profile"
  | "malformed-bundle"
  | "conversion-failed"
  | "filesystem-error";

/** The result of the import of one file. `cause` completes "Could not import X: …". */
export type ImportStep =
  | { result: "imported"; destination: string }
  | { result: ImportRefusal; cause: string };

/** The refusal for a destination that the import folder has already. */
export function destinationExists(folder: string, destination: string): ImportStep {
  return {
    result: "destination-exists",
    cause: trans("%s exists already in the import folder", path.relative(folder, destination)),
  };
}

/** The refusal for a call that the file system refused. An error of another kind is no result. */
export function filesystemFailure(failure: NodeJS.ErrnoException): ImportStep {
  if (failure.code === undefined) {
    throw failure;
  }
  return { result: "filesystem-error", cause: systemErrorCause(failure) };
}

/**
 * Copies a file to a destination in the import folder. The copy replaces
 * nothing: when something is at the destination, the file system refuses
 * the copy (`COPYFILE_EXCL`), also when it arrived after a check of the
 * caller.
 *
 * @param   {string}  source       The file to copy
 * @param   {string}  folder       The import folder
 * @param   {string}  destination  The new file in the import folder
 */
export async function placeFile(
  source: string,
  folder: string,
  destination: string,
): Promise<ImportStep> {
  return await fs.copyFile(source, destination, FS_CONSTANTS.COPYFILE_EXCL).then(
    (): ImportStep => ({ result: "imported", destination }),
    (failure: NodeJS.ErrnoException) => {
      return failure.code === "EEXIST"
        ? destinationExists(folder, destination)
        : filesystemFailure(failure);
    },
  );
}
