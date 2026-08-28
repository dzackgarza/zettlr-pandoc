import type { AnyDescriptor } from "@dts/common/fsal";
import { promises as fs } from "fs";
import path from "path";
import { ignorePath } from "source/common/util/ignore-path";

interface DirectoryReadLogger {
  error: (message: string, error?: unknown) => void;
}

export async function readDirectoryFromDisk(
  absPath: string,
  ignoreDotFiles: boolean,
  isDeadWorkspace: boolean,
  getDescriptor: (absPath: string) => Promise<AnyDescriptor>,
  logger: DirectoryReadLogger,
): Promise<AnyDescriptor[]> {
  if (isDeadWorkspace) {
    throw new Error(`[FSAL] Cannot read path ${absPath}: Not a directory!`);
  }

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
    const children = await fs.readdir(absPath, { withFileTypes: true });

    const childPaths = children
      .filter(
        (dirent) =>
          !ignorePath(dirent.name, ignoreDotFiles) && (dirent.isFile() || dirent.isDirectory()),
      )
      .map((dirent) => path.join(absPath, dirent.name));

    const results = await Promise.allSettled(
      childPaths.map(
        async (childPath) =>
          await getDescriptor(childPath).catch((err) =>
            logger.error(
              `[FSAL] Error while reading directory ${absPath}: Could not read child ${path.relative(absPath, childPath)}`,
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
