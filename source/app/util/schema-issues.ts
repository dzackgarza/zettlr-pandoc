/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The sentence of a schema failure
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A file of the author that does not have the shape that the
 *                  application reads is named with its cause. This function
 *                  writes the issues of a schema as that cause, on one line.
 *
 * END HEADER
 */

import type { z } from "zod";

/** Each issue of a schema failure as `field: what is wrong`, on one line. */
export function schemaIssueSentence(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}
