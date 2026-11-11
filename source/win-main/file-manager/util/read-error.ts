/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The mark of an item that the application could not read
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A file that the filesystem refuses to read has a
 *                  descriptor with the cause. A folder whose settings
 *                  file or Quarto manifest cannot be used, or that refuses
 *                  its content, names each such file with the cause. The
 *                  rows of the file manager show the causes with these
 *                  functions.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { AnyDescriptor, DirectoryMetadataProblem, FileReadError } from "@dts/common/fsal";

/** Why the last read of the text of an item failed, when it failed. */
export function readErrorOf(item: AnyDescriptor): FileReadError | undefined {
  return item.type === "file" || item.type === "code" ? item.readError : undefined;
}

/** The sentence that a row shows for the cause. */
export function readErrorSentence(error: FileReadError): string {
  return trans("Could not read this file: %s", error.message);
}

/** The metadata of a folder that the application could not use; none for a file. */
export function metadataProblemsOf(item: AnyDescriptor): DirectoryMetadataProblem[] {
  return item.type === "directory" ? item.metadataProblems : [];
}

/** The sentence that a row and the folder properties show for one problem. */
export function metadataProblemSentence(problem: DirectoryMetadataProblem): string {
  switch (problem.source) {
    case "settings":
      return trans(
        "The settings of this folder could not be read (%s): %s",
        problem.path,
        problem.message,
      );
    case "manifest":
      return trans("The Quarto book file %s could not be used: %s", problem.path, problem.message);
    case "directory":
      return trans("This folder could not be read: %s", problem.message);
  }
}

/** The sources of the problems of an item, for the attribute of its row. */
export function metadataProblemSources(item: AnyDescriptor): string | undefined {
  const problems = metadataProblemsOf(item);
  return problems.length === 0 ? undefined : problems.map((problem) => problem.source).join(" ");
}
