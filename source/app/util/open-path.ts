/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        openPath
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens a file, a folder or an address with the
 *                  application that the desktop has for it.
 *
 * END HEADER
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
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
 * Opens a target with `xdg-open`, as Electron's `shell.openPath` and
 * `shell.openExternal` do on Linux: in a process group of its own, with
 * `MM_NOTTTY=1` (`XDGOpen` in `shell/common/platform_util_linux.cc`). Since
 * electron/electron#48079 (Electron 37) Electron drops the result of
 * `xdg-open`: the promise of `shell.openPath` never settles, and the promise
 * of `shell.openExternal` resolves for a refused open. This function waits
 * for the exit of `xdg-open` itself, and rejects with the error that
 * `refusal` makes of the cause.
 */
async function xdgOpen(
  target: string,
  cwd: string | undefined,
  refusal: (cause: string) => Error,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const opener = spawn("xdg-open", [target], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MM_NOTTTY: "1" },
    });
    opener.on("error", (failure) => {
      reject(refusal(systemErrorCause(failure)));
    });
    opener.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const cause =
        code === null ? trans("xdg-open ended with the signal %s", signal) : xdgOpenCause(code);
      reject(refusal(cause));
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
    // The opener runs in the folder of the path, as Electron's does.
    await xdgOpen(target, path.dirname(target), (cause) => {
      return new AuthoredFileError("open", target, cause);
    });
    return;
  }
  const refusal = await shell.openPath(target);
  if (refusal !== "") {
    throw new AuthoredFileError("open", target, refusal);
  }
}

/**
 * Shows a file or a folder in the file browser of the desktop: a folder
 * opens itself, and a file opens its folder, with the application of the
 * desktop for a folder (`openPath`). This is the rule of "Open file browser
 * here" (`resolveDirectoryHere`). A path that cannot be examined rejects
 * with the cause.
 */
export async function revealPath(target: string): Promise<void> {
  const stats = await stat(target).catch((failure: NodeJS.ErrnoException) => {
    throw new AuthoredFileError("open", target, systemErrorCause(failure));
  });
  await openPath(stats.isDirectory() ? target : path.dirname(target));
}

/**
 * Opens an address (a web page, a mail address) with the application of the
 * desktop, and resolves when the opener ended. A refusal rejects with an
 * error that names the address and the cause. On Linux the opener is
 * `xdg-open`, and the promise settles as the one of `openPath` does. On
 * another platform `shell.openExternal` rejects for a refused open
 * (https://www.electronjs.org/docs/latest/api/shell#shellopenexternalurl-options).
 */
export async function openExternal(url: string): Promise<void> {
  const refusal = (cause: string): Error => new Error(trans("Could not open %s: %s.", url, cause));
  if (process.platform === "linux") {
    await xdgOpen(url, undefined, refusal);
    return;
  }
  await shell.openExternal(url).catch((failure: Error) => {
    throw refusal(failure.message);
  });
}
