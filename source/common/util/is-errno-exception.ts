/**
 * Narrows a caught value to the error object that Node's `fs` and
 * `child_process` APIs throw. These errors carry a string `code` such as
 * `ENOENT` (https://nodejs.org/api/errors.html#class-systemerror).
 */
export default function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && typeof err.code === "string";
}

/**
 * True when the caught value is a Node system error with one of the codes.
 */
export function hasErrnoCode(err: unknown, ...codes: string[]): boolean {
  return isErrnoException(err) && err.code !== undefined && codes.includes(err.code);
}
