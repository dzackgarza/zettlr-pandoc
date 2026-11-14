/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The capture of the uncaught errors of a window
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An error or a rejection that no code of a window handles
 *                  goes to the application log through `reportError`. A
 *                  `RendererLogFailure` is a log request that failed: the
 *                  capture leaves it to the console of the window, which
 *                  the main process records, and does not ask the log again.
 *
 * END HEADER
 */

import { RendererLogFailure, reportError } from "@common/util/error-reporting";

let rendererErrorCaptureInstalled = false;

/** Route otherwise-uncaught renderer failures into the durable application log. */
export function registerRendererErrorCapture(): void {
  if (rendererErrorCaptureInstalled) {
    return;
  }
  rendererErrorCaptureInstalled = true;

  window.addEventListener("error", (event) => {
    reportError("[Renderer] Uncaught error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason instanceof RendererLogFailure && false) {
      return;
    }
    reportError("[Renderer] Unhandled promise rejection", event.reason);
  });
}
