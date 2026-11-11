/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Texts of the action that repeats a refused action
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The documents provider refuses a close, a reload from
 *                  disk or a quit when the review of a document cannot be
 *                  written or its unsaved text cannot be discarded. The
 *                  message of the refusal has one action, which repeats what
 *                  was refused without that state. This module holds the
 *                  label of that action and the two messages of its result,
 *                  for each refused action.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { RefusedAction } from "@dts/common/documents";

export interface RefusedActionText {
  /** The label of the action that repeats the refused action. */
  label: () => string;
  /** The provider no longer holds the refusal of the named document. */
  notWaiting: (name: string) => string;
  /** The repeat of the action failed for the named document. */
  failed: (name: string, cause: string) => string;
}

export const REFUSED_ACTION_TEXT: Record<RefusedAction, RefusedActionText> = {
  close: {
    label: () => trans("Close anyway"),
    notWaiting: (name) => trans("%s is not waiting to close.", name),
    failed: (name, cause) => trans("Could not close %s: %s", name, cause),
  },
  reload: {
    label: () => trans("Load from disk anyway"),
    notWaiting: (name) => trans("%s is not waiting to load from disk.", name),
    failed: (name, cause) => trans("Could not load %s from disk: %s", name, cause),
  },
  quit: {
    label: () => trans("Quit anyway"),
    notWaiting: (name) => trans("The quit is not waiting for %s.", name),
    failed: (name, cause) => trans("Could not quit without the state of %s: %s", name, cause),
  },
};
