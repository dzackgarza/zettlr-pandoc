/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showRefusal
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one message of a window for a request that the main
 *                  process rejected.
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import { remoteErrorMessage } from "@common/util/ipc-rejection";
import showToast from "@common/util/show-toast";

/**
 * Shows the author the message of a rejected request of this window to the
 * main process, and records the rejection. The handler wrote the message
 * for the author: it names the file and the cause. This is for a request
 * that is no application command; the dispatcher shows the failure of a
 * command itself.
 */
export function showRefusal(failure: Error): void {
  reportError(failure);
  showToast(remoteErrorMessage(failure), "error", 12000);
}
