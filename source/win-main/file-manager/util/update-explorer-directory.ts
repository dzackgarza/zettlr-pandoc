/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        updateExplorerDirectory
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Writes a change of the Explorer settings of one directory
 *                  to the main process.
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import type { DirSettingsCommandAPI } from "source/app/service-providers/commands/dir-settings";
import type {
  AnyDescriptor,
  DirDescriptor,
  DirectoryExplorerSettings,
  DirectorySettings,
} from "source/types/common/fsal";

const ipcRenderer = window.ipc;

/**
 * Explorer choices apply one at a time, each to the settings the main process
 * holds once the choice before it is stored. The window's own descriptor is no
 * base for a choice: an FSAL broadcast of an earlier state can replace it
 * after a later choice was made, and a choice computed from it would write
 * that earlier state back.
 */
let explorerUpdates: Promise<void> = Promise.resolve();

export function updateExplorerDirectory(
  directory: DirDescriptor,
  settingsPatch: (stored: DirDescriptor) => Partial<DirectorySettings>,
  explorerPatch: Partial<DirectoryExplorerSettings> = {},
): Promise<void> {
  explorerUpdates = explorerUpdates
    .then(async () => {
      const stored: AnyDescriptor = await ipcRenderer.invoke("fsal", {
        command: "get-descriptor",
        payload: directory.path,
      });
      if (stored.type !== "directory") {
        throw new Error(`${directory.path} is no longer a directory`);
      }
      const settings = {
        ...settingsPatch(stored),
        explorer: { ...stored.settings.explorer, ...explorerPatch },
      };
      Object.assign(directory.settings, settings);
      try {
        await ipcRenderer.invoke("application", {
          command: "set-directory-setting",
          payload: { path: directory.path, settings } satisfies DirSettingsCommandAPI,
        });
      } catch (err) {
        Object.assign(directory.settings, stored.settings);
        throw err;
      }
    })
    .catch((err) => reportError("Could not update Explorer settings", err));
  return explorerUpdates;
}
