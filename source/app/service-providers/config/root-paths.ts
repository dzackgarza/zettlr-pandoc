/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Root paths of the configuration
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Decides which open files stay root files beside the open
 *                  workspaces.
 *
 * END HEADER
 */

import { realpathSync, type Stats } from "fs";
import { examinePath } from "source/common/util/examine-path";
import { innermostRoot } from "source/common/util/renderer-path-polyfill";

export interface RootPaths {
  openFiles: string[];
  openWorkspaces: string[];
}

/** The root paths without the open files that an open workspace holds. */
export function consolidateRootPaths({ openFiles, openWorkspaces }: RootPaths): RootPaths {
  return {
    openFiles: openFiles.filter((file) => innermostRoot(file, openWorkspaces) === undefined),
    openWorkspaces,
  };
}

/** Receives a root path that the filesystem could not examine, and the error. */
export type UnexaminedRootReport = (rootPath: string, error: NodeJS.ErrnoException) => void;

/**
 * The root paths that are on disk, each named by its real path: an open
 * file must be a file, an open workspace a directory, and a root that a
 * symbolic link names is the file or directory it points at, so no document
 * reaches the application under two names (#57). Two names of one root are
 * one root. A root path that the filesystem could not examine has given no
 * answer. It stays as it is, and `report` receives it: a workspace on a
 * mount that fails at one start is not removed for good.
 */
export function rootPathsOnDisk(roots: RootPaths, report: UnexaminedRootReport): RootPaths {
  const kept = (rootPaths: string[], isKind: (stats: Stats) => boolean): string[] => {
    const names = rootPaths.flatMap((rootPath) => {
      const examination = examinePath(rootPath, true);
      if (!examination.examined) {
        report(rootPath, examination.error);
        return [rootPath];
      }
      if (examination.stats === undefined || !isKind(examination.stats)) {
        return [];
      }
      return [realpathSync(rootPath)];
    });
    return [...new Set(names)];
  };

  return {
    openFiles: kept(roots.openFiles, (stats) => stats.isFile()),
    openWorkspaces: kept(roots.openWorkspaces, (stats) => stats.isDirectory()),
  };
}
