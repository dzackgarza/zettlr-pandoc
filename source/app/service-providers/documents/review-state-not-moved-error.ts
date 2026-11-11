/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewStateNotMovedError
 * CVM-Role:        Utility Class
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The error of a move that could not carry the sidecar of a
 *                  document to the key of its new path.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import path from "path";
import { systemErrorCause } from "source/app/util/system-error-cause";

/**
 * The files are at their new paths. The annotations and the review of each
 * document are still in the sidecar of its old path.
 */
export class ReviewStateNotMovedError extends Error {
  /**
   * @param  documentPaths  The new path of each document whose state stayed.
   * @param  causes         What stopped each write, without repeats.
   */
  constructor(
    public readonly documentPaths: readonly string[],
    public readonly causes: readonly string[],
  ) {
    super(
      documentPaths.length === 1
        ? trans(
            "The annotations and the review of %s did not move with the file: %s.",
            path.basename(documentPaths[0]),
            causes.join("; "),
          )
        : trans(
            "The annotations and the review of %s documents did not move with their files: %s.",
            documentPaths.length,
            causes.join("; "),
          ),
    );
    this.name = "ReviewStateNotMovedError";
  }

  /** The error of one document whose sidecar write failed. */
  static of(documentPath: string, failure: Error): ReviewStateNotMovedError {
    return new ReviewStateNotMovedError([documentPath], [systemErrorCause(failure)]);
  }

  /** One error for the documents of several. */
  static merged(errors: readonly ReviewStateNotMovedError[]): ReviewStateNotMovedError {
    return new ReviewStateNotMovedError(
      errors.flatMap((error) => error.documentPaths),
      [...new Set(errors.flatMap((error) => error.causes))],
    );
  }
}
