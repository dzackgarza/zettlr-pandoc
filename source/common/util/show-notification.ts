/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showNotification function
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A small utility function that can show native OS notifications.
 *
 * END HEADER
 */

import { runProcess } from "@dzack/external-process/run-process";
import { app, Notification, nativeImage } from "electron";
import path from "path";

/**
 * The default icon: The Zettlr logo
 */
const defaultIcon = nativeImage.createFromPath(path.join(__dirname, "../img/image-preview.png"));

/**
 * Shows a native notification for the operating system. If the operating
 * system does not support notifications, the notification will be logged and
 * the function returns false.
 *
 * @param   {string}   message   The message (body) of the notification
 * @param   {string}   title     The (optional) title; an untitled notification
 *                               is headed by the application's name
 * @param   {void}     callback  Optional callback, invoked when user clicks the notification
 *
 * @return  {Promise<boolean>}   False if the platform doesn't support notifications.
 *                               A caller that does not read the answer need
 *                               not wait: the app logs a rejection that no
 *                               caller handles (main.ts).
 */
export async function showNativeNotification(
  message: string,
  title?: string,
  callback?: () => void,
): Promise<boolean> {
  // Electron resolves the application's name from package.json `productName`.
  const appName = app.getName();
  const heading = title === undefined ? appName : title;
  if (!Notification.isSupported()) {
    // Electron's Linux notification support depends on the desktop session.
    // `notify-send` is the standard freedesktop/libnotify client and gives us
    // the same dismissible notification surface without owning another UI.
    if (process.platform === "linux") {
      // notify-send runs apart from the event loop of the main process, so
      // a session bus that is slow to answer stops no other work.
      const outcome = await runProcess({
        command: "notify-send",
        args: [`--app-name=${appName}`, "--urgency=normal", heading, message],
        env: process.env,
        timeLimitMs: "none",
        waitForGroup: false,
      });
      return outcome.ended === "exit" && outcome.code === 0;
    }
    return false;
  }

  const notification = new Notification({
    title: heading,
    body: message,
    silent: true,
    icon: defaultIcon,
    hasReply: false, // macOS only
    timeoutType: "default", // Windows/Linux only
    urgency: "low", // Linux only, we don't want to distract too much
    closeButtonText: "", // macOS only, empty means to use localized text
  });

  // Now show the notification
  notification.show();

  if (callback !== undefined) {
    notification.on("click", (event) => {
      callback();
    });
  }

  return true;
}
