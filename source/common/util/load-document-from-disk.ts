/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The "Load from disk" action of a notification
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A document whose file changed on disk keeps its editor
 *                  text until the author decides. Each message about that
 *                  state offers the same action: load the disk version.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast, { type ToastAction } from "@common/util/show-toast";
import type { SaveRefusal } from "@dts/common/documents";

/**
 * The action that replaces the editor text of the document at `filePath`
 * with the text of its file. A failure is shown with its cause.
 */
export function loadFromDiskAction(filePath: string): ToastAction {
  return {
    label: trans("Load from disk"),
    onAction: () => {
      window.ipc
        .invoke("documents-provider", {
          command: "load-from-disk",
          payload: { path: filePath },
        })
        .catch((err: unknown) => {
          showToast(
            trans(
              "Could not load %s from disk: %s",
              pathBasename(filePath),
              err instanceof Error ? err.message : String(err),
            ),
            "error",
            12000,
          );
        });
    },
  };
}

/**
 * The action that resolves a refused save of the document at `filePath`.
 * The disk version resolves a save that was refused because the file
 * changed on disk; no other refusal has an action here.
 */
export function saveRefusalAction(filePath: string, refusal: SaveRefusal): ToastAction | undefined {
  return refusal.reason === "disk-changed" ? loadFromDiskAction(filePath) : undefined;
}
