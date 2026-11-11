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
