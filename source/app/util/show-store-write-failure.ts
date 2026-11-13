/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showStoreWriteFailure
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one message for a file of the application (the
 *                  settings, the tags, the writing targets, the open tabs,
 *                  the window positions, the statistics) that a delayed
 *                  write could not save.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type LogProvider from "@providers/log";
import type WindowProvider from "@providers/windows";
import { systemErrorCause } from "./system-error-cause";

/**
 * Logs a failed write of a file of the application and tells the author in
 * an error window. The data stays in memory, so the changes hold until the
 * application closes; the file keeps its last contents.
 */
export function showStoreWriteFailure(
  log: Pick<LogProvider, "error">,
  windows: Pick<WindowProvider, "showErrorMessage">,
  filePath: string,
  failure: NodeJS.ErrnoException,
): void {
  log.error(`[Application] Could not write ${filePath}`, failure);
  windows.showErrorMessage(
    trans("Could not save the changes"),
    trans(
      "Could not write %s: %s. The changes hold until the application closes.",
      filePath,
      systemErrorCause(failure),
    ),
  );
}
