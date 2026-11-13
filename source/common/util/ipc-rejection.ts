/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The message of a rejected IPC call
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A handler of the main process that throws rejects the
 *                  `invoke` call of a window. Electron makes a new error for
 *                  the window, and puts the channel and the name of the
 *                  error class before the message of the handler:
 *
 *                    Error invoking remote method '<channel>': <error>
 *
 *                  where `<error>` is `error.toString()`, the name of the
 *                  class, a colon and the message. Reference: `invoke` in
 *                  `lib/renderer/api/ipc-renderer.ts` and the `-ipc-invoke`
 *                  handler in `lib/browser/api/web-contents.ts` of
 *                  electron/electron.
 *
 *                  A surface that shows the cause to the author shows the
 *                  message of the handler, without those two parts.
 *
 * END HEADER
 */

const INVOKE_PREFIX = /^Error invoking remote method '[^']*': /;
const ERROR_CLASS_PREFIX = /^[A-Za-z]*Error: /;

/** The message that the handler in the main process threw. */
export function remoteErrorMessage(failure: Error): string {
  if (!INVOKE_PREFIX.test(failure.message)) {
    return failure.message;
  }
  return failure.message.replace(INVOKE_PREFIX, "").replace(ERROR_CLASS_PREFIX, "");
}
