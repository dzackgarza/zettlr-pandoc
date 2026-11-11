/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AuthoredFileError
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The refusal of one operation on a file that the author
 *                  owns outside the workspaces: a Lua filter, an export
 *                  profile, the snippets file, the custom CSS. Its message
 *                  names the file and the cause, for the window that asked.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import path from "path";
import { systemErrorCause } from "./system-error-cause";

export type AuthoredFileOperation = "read" | "save" | "rename" | "remove" | "restore" | "open";

function sentence(operation: AuthoredFileOperation, filePath: string, cause: string): string {
  const name = path.basename(filePath);
  switch (operation) {
    case "read":
      return trans("Could not read %s: %s.", name, cause);
    case "save":
      return trans("Could not save %s: %s.", name, cause);
    case "rename":
      return trans("Could not rename %s: %s.", name, cause);
    case "remove":
      return trans("Could not remove %s: %s.", name, cause);
    case "restore":
      return trans("Could not restore the protected file %s: %s.", name, cause);
    case "open":
      return trans("Could not open %s: %s.", filePath, cause);
  }
}

/** An operation on a file of the author that did not happen. */
export class AuthoredFileError extends Error {
  constructor(
    readonly operation: AuthoredFileOperation,
    readonly filePath: string,
    cause: string,
  ) {
    super(sentence(operation, filePath, cause));
    this.name = "AuthoredFileError";
  }
}

/**
 * The rejection handler of one filesystem call on a file of the author:
 * `await fs.unlink(file).catch(refusedAs("remove", file))`.
 */
export function refusedAs(
  operation: AuthoredFileOperation,
  filePath: string,
): (failure: NodeJS.ErrnoException) => never {
  return (failure) => {
    throw new AuthoredFileError(operation, filePath, systemErrorCause(failure));
  };
}
