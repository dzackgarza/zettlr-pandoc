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

import isDir from "source/common/util/is-dir";
import isFile from "source/common/util/is-file";
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

/**
 * The root paths that are on disk: each open file as a file, each open
 * workspace as a directory.
 */
export function rootPathsOnDisk(roots: RootPaths): RootPaths {
  const openFiles = [...roots.openFiles];
  const openWorkspaces = [...roots.openWorkspaces];

  for (const file of openFiles) {
    if (!isFile(file)) {
      const idx = openFiles.indexOf(file);
      openFiles.splice(idx, 1);
    }
  }

  for (const workspace of openWorkspaces) {
    if (!isDir(workspace)) {
      const idx = openWorkspaces.indexOf(workspace);
      openWorkspaces.splice(idx, 1);
    }
  }

  return { openFiles, openWorkspaces };
}
