/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ignore rule menu items
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The context menu items that hide a file or a folder with
 *                  an ignore rule, or show it again.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { AnyMenuItem } from "@common/modules/window-register/application-menu-helper";
import { reportError } from "@common/util/error-reporting";
import showToast from "@common/util/show-toast";
import type { AnyDescriptor } from "@dts/common/fsal";
import { judgingRoot, ruleForName } from "source/common/util/ignore-rules";
import { useConfigStore, useIgnoreRulesStore } from "source/pinia";

const ipcRenderer = window.ipc;

function setPathIgnored(descriptor: AnyDescriptor, ignored: boolean): void {
  ipcRenderer
    .invoke("fsal", {
      command: "set-path-ignored",
      payload: { path: descriptor.path, isDirectory: descriptor.type === "directory", ignored },
    })
    .catch((err) => {
      reportError("Could not change the ignore rules", err);
      showToast(
        trans("Could not change the filters: %s", err instanceof Error ? err.message : String(err)),
        "error",
      );
    });
}

/**
 * The menu items that hide the item or show it again. A workspace root and a
 * path outside every workspace have none: no rule applies to them.
 */
export function ignoreMenuItems(descriptor: AnyDescriptor): AnyMenuItem[] {
  const configStore = useConfigStore();
  const { sources, filter } = useIgnoreRulesStore();
  const root = judgingRoot(sources.workspaceRules.keys(), descriptor.path);
  if (root === undefined) {
    return [];
  }

  const isDirectory = descriptor.type === "directory";

  if (descriptor.dir !== root && filter.matches(descriptor.dir, true)) {
    return [
      {
        id: "menu.ignored_with_parent",
        label: trans("Hidden with its folder"),
        type: "normal",
        enabled: false,
      },
    ];
  }

  if (filter.matches(descriptor.path, isDirectory)) {
    return [
      {
        id: "menu.unignore_path",
        label: isDirectory ? trans("Unhide folder") : trans("Unhide file"),
        type: "normal",
        action() {
          setPathIgnored(descriptor, false);
        },
      },
    ];
  }

  return [
    {
      id: "menu.ignore_path",
      label: isDirectory ? trans("Hide folder") : trans("Hide file"),
      type: "normal",
      action() {
        setPathIgnored(descriptor, true);
      },
    },
    {
      id: "menu.ignore_name",
      label: isDirectory
        ? trans("Hide all folders named “%s”", descriptor.name)
        : trans("Hide all files named “%s”", descriptor.name),
      type: "normal",
      action() {
        configStore.setConfigValue("fileManager.ignoreRules", [
          ...configStore.config.fileManager.ignoreRules,
          ruleForName(descriptor.name, isDirectory),
        ]);
      },
    },
  ];
}
