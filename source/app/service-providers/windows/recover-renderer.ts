/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        recoverRenderer function
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Gives the author a way out of a window whose renderer
 *                  process ended or does not respond: a native prompt that
 *                  loads the window again or closes it.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type LogProvider from "@providers/log";
import { type BrowserWindow, dialog, type MessageBoxOptions } from "electron";

const LOAD_AGAIN = 0;
const CLOSE = 1;
const KEEP_WAITING = 2;

/**
 * Prompts the author when the renderer of `window` ended or does not
 * respond. A window without a renderer shows nothing and takes no input, so
 * the prompt is a native message box.
 *
 * Each answer but "Keep waiting" starts a new renderer. The documents are in
 * the main process: the new renderer shows their unsaved text. The answer
 * "Close the window" then closes the window on the usual path, which asks
 * about unsaved text; when the author cancels there, the window works.
 *
 * The procedure is the one that Electron documents for
 * `webContents.forcefullyCrashRenderer()` and that VS Code has in
 * `CodeWindow.onWindowError` (src/vs/platform/windows/electron-main/windowImpl.ts):
 * end the hung renderer, then load the window in a new one.
 */
export default function recoverRenderer(logger: LogProvider, window: BrowserWindow): void {
  // True from the exit of the renderer until a new one starts.
  let rendererGone = false;
  // What the author chose for a renderer that does not respond. The new
  // renderer starts when Electron reports the exit of the hung one: a load
  // that starts before that exit does not happen.
  let afterKill: (() => void) | undefined;
  // The prompt about a renderer that does not respond, while it is open.
  let waitPrompt: AbortController | undefined;

  /** The button that the author chose, or nothing when the prompt was withdrawn. */
  async function ask(
    prompt: AbortController,
    options: MessageBoxOptions,
  ): Promise<number | undefined> {
    const withdraw = (): void => {
      prompt.abort();
    };
    window.once("closed", withdraw);
    const { response } = await dialog.showMessageBox(window, {
      ...options,
      noLink: true,
      normalizeAccessKeys: true,
      signal: prompt.signal,
    });
    window.off("closed", withdraw);
    return prompt.signal.aborted ? undefined : response;
  }

  function startRenderer(response: number): void {
    rendererGone = false;
    window.webContents.reload();
    if (response === CLOSE) {
      window.close();
    }
  }

  function act(response: number | undefined): void {
    if (response === undefined || response === KEEP_WAITING || window.isDestroyed()) {
      return;
    }
    if (rendererGone) {
      startRenderer(response);
      return;
    }
    // The renderer runs and does not respond: only its end lets the window
    // load in a new process. The main process ends it with SIGKILL, as
    // Electron's forcefullyCrashRenderer does on macOS and Windows
    // (RenderProcessHost::Shutdown in shell/browser/api/electron_api_web_contents.cc).
    // On Linux that method only asks the renderer to crash itself, and the
    // renderer exits when the crash dump is written: a dump that does not
    // end leaves the window without a renderer and without a prompt.
    afterKill = () => {
      startRenderer(response);
    };
    process.kill(window.webContents.getOSProcessId(), "SIGKILL");
  }

  function reportFailedPrompt(error: unknown): void {
    logger.error("[Window Manager] Could not ask what to do with a failed window", error);
  }

  const loadAgain = trans("&Load the window again");
  const close = trans("&Close the window");
  const unsavedText = trans(
    "Your documents are open and keep their unsaved text. A window that loads again shows it.",
  );

  window.webContents.on("render-process-gone", (_event, { reason, exitCode }) => {
    if (afterKill !== undefined) {
      const next = afterKill;
      afterKill = undefined;
      next();
      return;
    }
    rendererGone = true;
    waitPrompt?.abort();
    ask(new AbortController(), {
      type: "error",
      title: trans("Window stopped"),
      message: trans("The window stopped working."),
      detail: `${trans("Its renderer process ended (reason: %s, exit code: %s).", reason, exitCode)}\n\n${unsavedText}`,
      buttons: [loadAgain, close],
      defaultId: LOAD_AGAIN,
      cancelId: LOAD_AGAIN,
    })
      .then(act)
      .catch(reportFailedPrompt);
  });

  window.on("unresponsive", () => {
    if (rendererGone || waitPrompt !== undefined) {
      return;
    }
    const prompt = new AbortController();
    waitPrompt = prompt;
    ask(prompt, {
      type: "warning",
      title: trans("Window not responding"),
      message: trans("The window does not respond."),
      detail: `${unsavedText} ${trans("Text that the window did not send to its document before it stopped is lost when the window loads again.")}`,
      buttons: [loadAgain, close, trans("&Keep waiting")],
      defaultId: KEEP_WAITING,
      cancelId: KEEP_WAITING,
    })
      .then((response) => {
        waitPrompt = undefined;
        act(response);
      })
      .catch(reportFailedPrompt);
  });

  window.on("responsive", () => {
    waitPrompt?.abort();
  });
}
