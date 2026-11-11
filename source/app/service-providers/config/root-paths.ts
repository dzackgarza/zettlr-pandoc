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

import type { Stats } from "fs";
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
 * The root paths without those that are not on disk: an open file must be a
 * file, an open workspace a directory. A root path that the filesystem could
 * not examine has given no answer. It stays, and `report` receives it: a
 * workspace on a mount that fails at one start is not removed for good.
 */
export function rootPathsOnDisk(roots: RootPaths, report: UnexaminedRootReport): RootPaths {
  const keeps = (rootPath: string, isKind: (stats: Stats) => boolean): boolean => {
    const examination = examinePath(rootPath, false);
    if (!examination.examined) {
      report(rootPath, examination.error);
      return true;
    }
    return examination.stats !== undefined && isKind(examination.stats);
  };

  return {
    openFiles: roots.openFiles.filter((file) => keeps(file, (stats) => stats.isFile())),
    openWorkspaces: roots.openWorkspaces.filter((workspace) =>
      keeps(workspace, (stats) => stats.isDirectory()),
    ),
  };
}
