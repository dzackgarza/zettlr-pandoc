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

export interface RootPaths {
  openFiles: string[];
  openWorkspaces: string[];
}

/** The root paths without the open files that an open workspace holds. */
export function consolidateRootPaths({ openFiles, openWorkspaces }: RootPaths): RootPaths {
  for (const openFile of openFiles) {
    for (const workspace of openWorkspaces) {
      if (openFile.startsWith(workspace)) {
        openFiles.splice(openFiles.indexOf(openFile), 1);
      }
    }
  }

  return { openFiles, openWorkspaces };
}
