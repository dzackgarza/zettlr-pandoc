/**
 * The scene of a window whose log request fails, for the Chromium probe
 * (renderer-log-failure-probe.mjs). The bridge answers each `log-provider`
 * request as Electron answers a channel without a handler. The page installs
 * the capture of the window and reports one error.
 */

import { registerRendererErrorCapture } from "@common/modules/window-register/renderer-error-capture";
import { reportError } from "@common/util/error-reporting";

declare global {
  interface Window {
    logRequests: () => number;
  }
}

let logRequests = 0;

Object.defineProperty(window, "ipc", {
  value: {
    invoke: async (channel: string): Promise<never> => {
      if (channel === "log-provider") {
        logRequests += 1;
      }
      throw new Error(
        `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
      );
    },
  },
});

window.logRequests = () => logRequests;
registerRendererErrorCapture();
reportError("Could not read the review of lattices.md", "EACCES: permission denied");
