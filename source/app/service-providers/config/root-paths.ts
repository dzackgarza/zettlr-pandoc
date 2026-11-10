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
