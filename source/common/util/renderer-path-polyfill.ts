/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Rendererer path polyfill functions
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module contains a subset of Node.js's path functions
 *                  which we need despite the renderer sandbox. A function
 *                  here gives the result of the Node.js function for the
 *                  same absolute paths.
 *
 * END HEADER
 */

/**
 * Returns the correct path separator for the given path.
 *
 * @param   {string}  path  The path to check
 *
 * @return  {string}        Either \ or /
 */
function sep(path: string): "\\" | "/" {
  return isWin32Path(path) ? "\\" : "/";
}

/** Whether a path lies strictly inside a directory, at a path-segment boundary. */
export function isInsideRoot(documentPath: string, rootPath: string): boolean {
  if (!documentPath.startsWith(rootPath) || documentPath === rootPath) {
    return false;
  }
  const boundary =
    rootPath.endsWith("/") || rootPath.endsWith("\\")
      ? rootPath.slice(-1)
      : documentPath.charAt(rootPath.length);
  return boundary === "/" || boundary === "\\";
}

/** Whether a path is a directory or lies inside it. */
export function isAtOrInsideRoot(documentPath: string, rootPath: string): boolean {
  return documentPath === rootPath || isInsideRoot(documentPath, rootPath);
}

/**
 * The root that holds a path: of the roots that the path lies inside, the
 * innermost. A root does not hold itself. Every decision of the workspace or
 * the directory that a path belongs to goes through this function.
 */
export function innermostRoot(documentPath: string, roots: Iterable<string>): string | undefined {
  let innermost: string | undefined;
  for (const root of roots) {
    if (
      isInsideRoot(documentPath, root) &&
      (innermost === undefined || root.length > innermost.length)
    ) {
      innermost = root;
    }
  }
  return innermost;
}

/**
 * Utility function that checks if a path is likely a win32-path
 *
 * @param   {string}   path  The path to check
 *
 * @return  {boolean}        Returns true if the path includes backslashes but
 *                           no forward slashes.
 */
export function isWin32Path(path: string): boolean {
  // We make use of the fact that on Windows, forward slashes are forbidden in
  // path names, and it is unusual to see backslashes in Unix paths.
  return path.includes("\\") && !path.includes("/");
}

/**
 * Returns true if provided path equals the root on a Windows or Unix machine.
 *
 * @param   {string}   path  The path to check
 *
 * @return  {boolean}        True if it equals the root directory
 */
function isRootDir(path: string): boolean {
  return path === "/" || /^[A-Z]:\\$/i.test(path);
}

/**
 * Returns true if the given path is absolute.
 *
 * @param   {string}   path  The path to check
 *
 * @return  {boolean}        True if it's absolute
 */
export function isAbsolutePath(path: string): boolean {
  if (path.length < 2) {
    return false; // Invalid length
  } else if (path.length >= 1 && path.startsWith("/")) {
    return true; // Unix
  } else if (path.length >= 3 && (/^[A-Z]:[\\/]/i.test(path) || path.startsWith("\\\\"))) {
    return true; // Windows (drive letters + network drives)
  } else {
    return false;
  }
}

/**
 * A path as its root and the names below the root. A relative path has the
 * empty root. `splitPath`, `relativePath` and `resolvePath` follow
 * `normalizeString`, `relative` and `resolve` of the Node.js path module
 * (https://github.com/nodejs/node/blob/main/lib/path.js). Node.js resolves a
 * relative path against the working directory; the renderer has none, so a
 * relative path stays relative here.
 */
interface PathParts {
  root: string;
  segments: string[];
}

const WIN32_DRIVE_ROOT = /^[A-Za-z]:[\\/]+/;
const WIN32_SHARE_ROOT = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]*/;

/** The root of a path, and the length of the text that spells it. */
function pathRoot(path: string, win32: boolean): { root: string; length: number } {
  if (!win32) {
    return path.startsWith("/") ? { root: "/", length: 1 } : { root: "", length: 0 };
  }

  const drive = WIN32_DRIVE_ROOT.exec(path);
  if (drive !== null) {
    return { root: `${path.slice(0, 2)}\\`, length: drive[0].length };
  }

  const share = WIN32_SHARE_ROOT.exec(path);
  if (share !== null) {
    return { root: `\\\\${share[1]}\\${share[2]}\\`, length: share[0].length };
  }

  return /^[\\/]/.test(path) ? { root: "\\", length: 1 } : { root: "", length: 0 };
}

/**
 * Removes each `.` segment and applies each `..` segment to the name before
 * it. A `..` segment that has no name before it is dropped below a root and
 * stays in a relative path.
 */
function normalizeSegments(segments: string[], rooted: boolean): string[] {
  const names: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment !== "..") {
      names.push(segment);
    } else if (names.length > 0 && names[names.length - 1] !== "..") {
      names.pop();
    } else if (!rooted) {
      names.push("..");
    }
  }

  return names;
}

/** Splits a path into its root and its names in their shortest form. */
function splitPath(path: string, win32: boolean): PathParts {
  const { root, length } = pathRoot(path, win32);
  const segments = path.slice(length).split(win32 ? /[\\/]+/ : /\/+/);
  return { root, segments: normalizeSegments(segments, root !== "") };
}

/**
 * Returns the relative path from from to to. When no relative path leads from
 * one to the other (two drives, or one absolute and one relative path), this
 * is the target path.
 *
 * @param   {string}  from  The source location
 * @param   {string}  to    The target location
 *
 * @return  {string}        The relative path
 */
export function relativePath(from: string, to: string): string {
  if (sep(from) !== sep(to)) {
    throw new Error("Cannot calculate relative path between win32 and Unix paths");
  }

  const win32 = isWin32Path(from);
  const separator = sep(from);
  const source = splitPath(from, win32);
  const target = splitPath(to, win32);
  // Two Windows names that differ only in case name the same file.
  const sameName = (a: string, b: string): boolean =>
    win32 ? a.toLowerCase() === b.toLowerCase() : a === b;

  if (!sameName(source.root, target.root)) {
    return target.root + target.segments.join(separator);
  }

  let common = 0;
  while (
    common < source.segments.length &&
    common < target.segments.length &&
    sameName(source.segments[common], target.segments[common])
  ) {
    common++;
  }

  const sourceRest = source.segments.slice(common);
  if (sourceRest.includes("..")) {
    throw new Error(
      `No relative path leads from "${from}" to "${to}": the names above "${from}" are unknown`,
    );
  }

  return [...sourceRest.map(() => ".."), ...target.segments.slice(common)].join(separator);
}

/**
 * Resolves the provided (relative) path using the (absolute) base to an
 * absolute path to the resource. The result is in its shortest form: it has
 * no `.` segment, no `..` segment after a name, and no separator at its end
 * unless it is a root.
 *
 * @param   {string}  base  The base.
 * @param   {string}  path  The path.
 *
 * @return  {string}        The path, turned absolute.
 */
export function resolvePath(base: string, path: string): string {
  const win32 = isWin32Path(base);
  const target = splitPath(path, win32);
  if (target.root !== "") {
    return target.root + target.segments.join(sep(base));
  }

  const origin = splitPath(base, win32);
  const segments = normalizeSegments([...origin.segments, ...target.segments], origin.root !== "");
  if (origin.root === "" && segments.length === 0) {
    return ".";
  }

  return origin.root + segments.join(sep(base));
}

/**
 * Returns the last part of a path, i.e. either a filename or a directory name.
 *
 * @param   {string}  path     The path to extract from
 * @param   {string}  extname  An optional extension to strip from the basename
 *
 * @return  {string}           The basename
 */
export function pathBasename(path: string, extname?: string): string {
  const basename = path.substring(path.lastIndexOf(sep(path)) + 1);
  if (extname !== undefined && basename.endsWith(extname)) {
    return basename.substring(0, basename.length - extname.length);
  } else {
    return basename;
  }
}

/**
 * Returns the path extension (which can also be .app for folder bundles on
 * macOS).
 *
 * @param   {string}  path  The path to extract from
 *
 * @return  {string}        The extension name; empty string if no extension
 */
export function pathExtname(path: string): string {
  return path.includes(".") ? path.substring(path.lastIndexOf(".")) : "";
}

/**
 * Returns the directory name of a path (i.e., the parent directory). Returns
 * identity if path is the root directory, and an empty string if it describes
 * only a folder/file. NOTE: This function returns '..' or '.' if applicable.
 *
 * @param   {string}  path  The path to extract from
 *
 * @return  {string}        The directory name
 */
export function pathDirname(path: string): string {
  if (isRootDir(path)) {
    return path;
  }
  const s = sep(path);
  const lastIndex = path.lastIndexOf(s);

  // This is to handle direct children under the root directory,
  // so that the final path separator is not removed, such as
  // `C:\Notes`, `/notes`, etc.
  const isRoot = isAbsolutePath(path) && path.indexOf(s) === lastIndex;
  return lastIndex > -1 ? path.substring(0, isRoot ? lastIndex + 1 : lastIndex) : ".";
}
