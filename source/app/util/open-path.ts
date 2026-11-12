/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        openPath
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens a file or a folder with the application that the
 *                  desktop has for it.
 *
 * END HEADER
 */

import { spawn } from "node:child_process";
import { trans } from "@common/i18n-main";
import { shell } from "electron";
import path from "path";
import { AuthoredFileError } from "./authored-file-error";
import { systemErrorCause } from "./system-error-cause";

/**
 * What an exit code of `xdg-open` means, as xdg-open(1) states it. Electron
 * gave the same words for a refused open before its change
 * electron/electron#48079 (`GetErrorDescription` in
 * `shell/common/platform_util_linux.cc`).
 */
function xdgOpenCause(code: number): string {
  switch (code) {
    case 1:
      return trans("error in command line syntax");
    case 2:
      return trans("the item does not exist");
    case 3:
      return trans("a required tool could not be found");
    case 4:
      return trans("the action failed");
    default:
      return trans("xdg-open ended with the exit code %s", code);
  }
}

/**
 * Opens a path with `xdg-open`, as Electron's `shell.openPath` does on Linux:
 * in the folder of the path, in a process group of its own, with
 * `MM_NOTTTY=1` (`XDGOpen` in `shell/common/platform_util_linux.cc`). Since
 * electron/electron#48079 (Electron 37) Electron drops the result of
 * `xdg-open`, and its promise never settles; this function waits for the
 * exit of `xdg-open` itself.
 */
async function xdgOpen(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const opener = spawn("xdg-open", [target], {
      cwd: path.dirname(target),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MM_NOTTTY: "1" },
    });
    opener.on("error", (failure) => {
      reject(new AuthoredFileError("open", target, systemErrorCause(failure)));
    });
    opener.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const cause =
        code === null ? trans("xdg-open ended with the signal %s", signal) : xdgOpenCause(code);
      reject(new AuthoredFileError("open", target, cause));
    });
  });
}

/**
 * Opens a path with the application of the desktop, and resolves when the
 * opener ended. A refusal rejects with an `AuthoredFileError` that names the
 * path and the cause, so a caller cannot take it for a success.
 *
 * On Linux the opener is `xdg-open`. Under a desktop that `xdg-open` knows,
 * it hands the path to the desktop and ends. Under another one (Hyprland,
 * for example) it runs the application and ends with it, so the promise
 * settles only when the author closes the application. A caller that does
 * not do its work after the open does not wait: it attaches the display of
 * the refusal and goes on.
 *
 * On another platform Electron resolves `shell.openPath` with the words of
 * the refusal, and with an empty string for a path that opened
 * (https://www.electronjs.org/docs/latest/api/shell#shellopenpathpath).
 */
export async function openPath(target: string): Promise<void> {
  if (process.platform === "linux") {
    await xdgOpen(target);
    return;
  }
  const refusal = await shell.openPath(target);
  if (refusal !== "") {
    throw new AuthoredFileError("open", target, refusal);
  }
}
