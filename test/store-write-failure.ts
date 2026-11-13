/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        unexpectedStoreWriteFailure
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The write-failure handler of a store in a spec whose
 *                  writes must succeed.
 *
 * END HEADER
 */

/** A failed write that the spec did not expect stops the spec. */
export function unexpectedStoreWriteFailure(
  filePath: string,
  failure: NodeJS.ErrnoException,
): never {
  throw new Error(`The spec did not expect the write of ${filePath} to fail`, { cause: failure });
}
