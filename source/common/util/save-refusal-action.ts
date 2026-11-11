/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The actions of a refused save
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A refused save leaves text that is not on disk. Each
 *                  message about a refused save offers each step that the
 *                  author can take: load the disk version or go to the
 *                  review when the file changed on disk under a review, or
 *                  write the text to another file when the text cannot
 *                  reach the file of the document.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { loadFromDiskAction } from "@common/util/load-document-from-disk";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast, { type ToastAction } from "@common/util/show-toast";
import type { SaveRefusal } from "@dts/common/documents";

/**
 * The action that writes the text that the application holds of the
 * document at `filePath` to a file that the author chooses. The document
 * stays unsaved. A copy that fails is shown with its cause and with the
 * same action.
 */
export function saveCopyAction(filePath: string): ToastAction {
  const name = pathBasename(filePath);
  return {
    label: trans("Save a copy…"),
    onAction: () => {
      window.ipc
        .invoke("documents-provider", {
          command: "save-copy",
          payload: { path: filePath },
        })
        .then((copy: string | undefined) => {
          if (copy === undefined) {
            return; // The author chose no file.
          }
          showToast(
            trans("The text of %s is in %s. %s itself is not saved.", name, copy, name),
            "info",
            12000,
          );
        })
        .catch((err: unknown) => {
          showToast(
            trans(
              "Could not save a copy of %s: %s",
              name,
              err instanceof Error ? err.message : String(err),
            ),
            "error",
            12000,
            saveCopyAction(filePath),
          );
        });
    },
  };
}

/**
 * The action that opens the Annotations view. The view has the controls of
 * a review that a change of the file froze: reapply it, return it to its
 * agent, or discard it.
 */
export function showReviewAction(): ToastAction {
  return {
    label: trans("Show the review"),
    onAction: () => {
      window.config.set("window.sidebarVisible", true);
    },
  };
}

/**
 * The actions that a refused save of the document at `filePath` offers.
 * A save is refused as `disk-changed` when the file changed on disk under
 * a review: the disk version resolves it, and so does a decision on the
 * review. A copy takes the text out of a document whose file or review
 * cannot be written. The other refusals leave no text that only the
 * application holds.
 */
export function saveRefusalActions(filePath: string, refusal: SaveRefusal): ToastAction[] {
  switch (refusal.reason) {
    case "disk-changed":
      return [loadFromDiskAction(filePath), showReviewAction()];
    case "disk-unreadable":
    case "write-failed":
    case "review-not-persisted":
      return [saveCopyAction(filePath)];
    case "not-loaded":
    case "saved-not-refreshed":
    case "discard-failed":
      return [];
  }
}
