import isErrnoException, { hasErrnoCode } from "@common/util/is-errno-exception";
import type { AnyDescriptor } from "@dts/common/fsal";
import { promises as fs } from "fs";
import path from "path";
import { ignorePath } from "source/common/util/ignore-path";
import type { IgnoreFilter } from "source/common/util/ignore-rules";

interface DirectoryReadLogger {
  error: (message: string, error?: unknown) => void;
}

interface DirectoryChild {
  path: string;
  isDirectory: boolean;
}

/** A path that enters or leaves the listing when the ignore rules change. */
export interface VisibilityChange extends DirectoryChild {
  visible: boolean;
}

/**
 * The files and folders of a directory that the ignore rules then judge: no
 * symbolic link, no built-in ignored name. Dot files are the concern of the
 * filter, so that "Turn the filters off" lists them.
 */
async function candidateChildren(directoryPath: string): Promise<DirectoryChild[]> {
  const children = await fs.readdir(directoryPath, { withFileTypes: true });
  return children
    .filter(
      (dirent) => !ignorePath(dirent.name, false) && (dirent.isFile() || dirent.isDirectory()),
    )
    .map((dirent) => ({
      path: path.join(directoryPath, dirent.name),
      isDirectory: dirent.isDirectory(),
    }));
}

async function listedChildren(
  directoryPath: string,
  ignoreFilter: IgnoreFilter,
): Promise<DirectoryChild[]> {
  const children = await candidateChildren(directoryPath);
  return children.filter((child) => !ignoreFilter.hides(child.path, child.isDirectory));
}

export async function readDirectoryFromDisk(
  absPath: string,
  ignoreFilter: IgnoreFilter,
  getDescriptor: (absPath: string) => Promise<AnyDescriptor>,
  logger: DirectoryReadLogger,
): Promise<AnyDescriptor[]> {
  let isDirectory: boolean;
  try {
    isDirectory = (await fs.lstat(absPath)).isDirectory();
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw new Error(`[FSAL] Cannot read path ${absPath}: Not a directory!`);
  }

  if (!isDirectory) {
    throw new Error(`[FSAL] Cannot read path ${absPath}: Not a directory!`);
  }

  try {
    const children = await listedChildren(absPath, ignoreFilter);

    const results = await Promise.allSettled(
      children.map(
        async (child) =>
          await getDescriptor(child.path).catch((err) =>
            logger.error(
              `[FSAL] Error while reading directory ${absPath}: Could not read child ${path.relative(absPath, child.path)}`,
              err,
            ),
          ),
      ),
    );

    return results
      .filter(
        (result): result is PromiseFulfilledResult<AnyDescriptor> =>
          result.status === "fulfilled" && result.value !== undefined,
      )
      .map((result) => result.value);
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error(`[FSAL] Could not read directory: ${absPath}`, err);
    }

    return [];
  }
}

/** A folder of a listing whose content the listing does not hold, with the cause. */
export interface FolderNotListed {
  path: string;
  cause: string;
}

/** The paths that a walk lists, and the folders whose content it does not hold. */
export interface DirectoryListing {
  paths: string[];
  notListed: FolderNotListed[];
}

/**
 * Lists a directory and everything below it that the app lists: the directory
 * itself, then each listed file and folder. A directory whose content the
 * filesystem refuses is a path of the listing, without content, and is in
 * `notListed` with the cause. A folder below the directory that is gone when
 * the walk reaches it (`ENOENT`, `ENOTDIR`) is not a path of the listing.
 */
export async function readDirectoryRecursivelyFromDisk(
  directoryPath: string,
  ignoreFilter: IgnoreFilter,
  logger: DirectoryReadLogger,
): Promise<DirectoryListing> {
  return await walkDirectory(directoryPath, true, ignoreFilter, logger);
}

async function walkDirectory(
  directoryPath: string,
  isTop: boolean,
  ignoreFilter: IgnoreFilter,
  logger: DirectoryReadLogger,
): Promise<DirectoryListing> {
  const listing = await listedChildren(directoryPath, ignoreFilter).then(
    (children) => ({ children }),
    (cause: unknown) => ({ cause }),
  );
  if ("cause" in listing) {
    const cause = listing.cause;
    if (!isErrnoException(cause)) {
      throw cause;
    }
    if (!isTop && hasErrnoCode(cause, "ENOENT", "ENOTDIR")) {
      return { paths: [], notListed: [] };
    }
    if (!hasErrnoCode(cause, "EACCES", "EPERM")) {
      logger.error(`[FSAL] Could not read directory: ${directoryPath}`, cause);
    }
    return { paths: [directoryPath], notListed: [{ path: directoryPath, cause: cause.message }] };
  }

  const contents = await Promise.all(
    listing.children.map(async (child): Promise<DirectoryListing> => {
      return child.isDirectory
        ? await walkDirectory(child.path, false, ignoreFilter, logger)
        : { paths: [child.path], notListed: [] };
    }),
  );
  return {
    paths: [directoryPath, ...contents.flatMap((content) => content.paths)],
    notListed: contents.flatMap((content) => content.notListed),
  };
}

/**
 * Reports the paths below a workspace root that the listing gains or loses
 * when the ignore filter changes from `before` to `after`. The order is the
 * one a watcher gives for the same change on disk: a folder that becomes
 * visible comes before its content, a folder that becomes hidden after it.
 *
 * The walk stops at each path in `otherRoots`: another open workspace lists
 * that folder and its content whatever this workspace's rules say.
 */
export async function visibilityChanges(
  directoryPath: string,
  otherRoots: ReadonlySet<string>,
  before: IgnoreFilter,
  after: IgnoreFilter,
  logger: DirectoryReadLogger,
): Promise<VisibilityChange[]> {
  let children: DirectoryChild[];
  try {
    children = await candidateChildren(directoryPath);
  } catch (err: unknown) {
    logger.error(`[FSAL] Could not read directory: ${directoryPath}`, err);
    return [];
  }

  const changes: VisibilityChange[] = [];
  for (const child of children) {
    if (otherRoots.has(child.path)) {
      continue;
    }

    const wasVisible = !before.hides(child.path, child.isDirectory);
    const isVisible = !after.hides(child.path, child.isDirectory);
    if (!wasVisible && !isVisible) {
      continue;
    }

    const below = child.isDirectory
      ? await visibilityChanges(child.path, otherRoots, before, after, logger)
      : [];
    if (wasVisible === isVisible) {
      changes.push(...below);
    } else if (isVisible) {
      changes.push({ ...child, visible: true }, ...below);
    } else {
      changes.push(...below, { ...child, visible: false });
    }
  }
  return changes;
}
