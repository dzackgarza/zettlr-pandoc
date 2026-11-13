/**
 * @ignore
 * BEGIN HEADER    TODO: MOVE TO LIFECYCLE!
 *
 * Contains:        attachAppNavigationHandlers function
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Listens to navigation events on all webContents across the
 *                  application. Must be called exactly once per app run.
 *
 * END HEADER
 */

import { spawn } from "node:child_process";
import { trans } from "@common/i18n-main";
import { reportError } from "@common/util/error-reporting";
import { app, type WebContents } from "electron";
import type LogProvider from "../service-providers/log";
import { filePathOfUri } from "./file-uri-path";
import { openExternal, openPath } from "./open-path";
import { showRefusalInWindow } from "./show-refusal-in-window";
import { systemErrorCause } from "./system-error-cause";

/**
 * Opens the target of a navigation that the window does not make itself: a
 * PDF at a page in Okular, a file with the application of the desktop, and
 * an address in the browser of the desktop. A refusal is shown in the window
 * that navigated.
 *
 * @param   {string}       url     The URL of the navigation.
 * @param   {WebContents}  window  The window that navigated.
 */
function openOutside(url: string, window: WebContents): void {
  if (url.startsWith("safe-file://")) {
    const filePath = filePathOfUri(url);
    const page = new URL(url).hash.match(/^#page=([1-9]\d*)$/);
    if (page !== null) {
      const viewer = spawn("okular", ["--page", page[1], filePath], {
        detached: true,
        stdio: "ignore",
      });
      viewer.on("error", (err) => {
        const refusal = new Error(trans("Could not open %s: %s.", filePath, systemErrorCause(err)));
        reportError(`[Window Manager] ${refusal.message}`);
        showRefusalInWindow(window, "open-link", refusal);
      });
      viewer.unref();
      return;
    }
    // The path of the file goes to the desktop.
    openPath(filePath).catch((err: Error) => {
      reportError(`[Window Manager] ${err.message}`);
      showRefusalInWindow(window, "open-link", err);
    });
  } else {
    openExternal(url).catch((err: Error) => {
      reportError(`[Window Manager] ${err.message}`);
      showRefusalInWindow(window, "open-link", err);
    });
  }
}

/**
 * Hooks up an event listener that responds to any new web content being
 * created. Whenever a new webContents is being created, it attaches two event
 * listeners to it that will prevent two things:
 *
 * 1. Prevent navigation away from the window's loaded URL
 * 2. Prevent opening of arbitrary windows with external URLs
 *
 * Instead, the handler will defer opening the passed URL to a helper function
 * that opens that URL in the system's actual web browser, or shows the file in
 * the file browser, if applicable.
 */
export function attachAppNavigationHandlers(log: LogProvider): void {
  const devServerOrigin = app.isPackaged ? undefined : new URL(MAIN_WINDOW_WEBPACK_ENTRY).origin;

  app.on("web-contents-created", (event, webContents) => {
    webContents.setWindowOpenHandler(({ url }) => {
      log.info(`[Navigation Handler] Preventing opening a new window to <${url}>`);
      // NOTE: This is only called when a *renderer* wants to open a new window.
      // We always disallow this since we only create our windows from the main
      // process.
      return { action: "deny" };
    });

    webContents.on("will-navigate", (event, url) => {
      log.info(`[Navigation Handler] webContents wants to navigate to ${url}`);
      // NOTE: app.isPackaged is false if the executable is called electron
      // (instead of Zettlr)
      if (devServerOrigin !== undefined && new URL(url).origin === devServerOrigin) {
        // We are in development, so we must make sure to allow webpack to
        // actually reload the windows. Webpack will always spin up devServers
        // at localhost.
        return true;
      }

      // Prevent any navigation from within the window. Instead, transform this
      // into a shell command to open in an actual browser, not within our own
      // browser windows.
      event.preventDefault();
      openOutside(url, webContents);
    });
  });
}
