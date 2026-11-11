/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Native message boxes of an E2E run
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A native message box is not a page, so Playwright does not
 *                  see it. A spec finds the box by its title and answers it
 *                  with xdotool, and captures it with ImageMagick, on the X
 *                  display of the run. With `DISPLAY` set, the keys go to the
 *                  desktop of the author: such a spec runs on the display of
 *                  the run only.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "./electron-app";

const run = promisify(execFile);

/** The X windows that `xdotool search` finds; none is exit status 1, not an error. */
export function searchWindows(criteria: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const search = spawn("xdotool", ["search", "--onlyvisible", ...criteria], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    search.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    search.once("error", reject);
    search.once("close", () => {
      resolve(stdout.split("\n").filter((line) => line !== ""));
    });
  });
}

/** The native message boxes with this title that are on the screen before the time limit. */
export async function nativeDialogs(title: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = await searchWindows(["--name", `^${title}$`]);
    if (windows.length > 0 || Date.now() > deadline) {
      return windows;
    }
    await delay(250);
  }
}

/** The one native message box with this title that is on the screen before the time limit. */
export async function nativeDialog(title: string, timeoutMs: number): Promise<string> {
  const windows = await nativeDialogs(title, timeoutMs);
  assert.equal(windows.length, 1, `one window has the title "${title}": ${windows.join(" ")}`);
  return windows[0];
}

/** A PNG of one X window; `root` is the whole display. */
export async function captureWindow(window: string): Promise<Buffer> {
  const { stdout } = await run("import", ["-window", window, "png:-"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Sends one key to a window. Return activates the default button of a message box. */
export async function pressKey(window: string, key: string): Promise<void> {
  await run("xdotool", ["windowfocus", "--sync", window, "key", key], { timeout: 30_000 });
}
