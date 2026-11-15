/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        closeWithDocuments
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The close of a main window that is not the last one. The
 *                  documents provider lets the documents of the window go
 *                  first; the window closes only when it did.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type LogProvider from "@providers/log";
import { type RefusalTarget, showRefusalInWindow } from "source/app/util/show-refusal-in-window";

/** What the close of a main window asks of the documents provider. */
export interface WindowCloseDocuments {
  /** Whether no document of the window has unsaved text. */
  isClean: (windowId: string) => boolean;
  /** Asks the author about the unsaved text; answers whether the window may close. */
  askUserToCloseWindow: (windowId: string, closeAgain: () => Promise<void>) => Promise<boolean>;
  /** Lets the documents of a clean window go; answers whether the window may close. */
  closeWindow: (windowId: string, closeAgain: () => Promise<void>) => Promise<boolean>;
}

/** The main window that the author closes. */
export interface ClosingWindow {
  close: () => void;
  webContents: RefusalTarget;
}

/**
 * Settles the documents of a main window and then closes it. The caller has
 * stopped the close that started this; `permitClose` runs before the close
 * that this function starts, so the caller lets that one pass.
 *
 * A window whose documents the provider keeps stays open: the provider told
 * the author why (AGENTS.md §14). A close that fails keeps the window too:
 * its documents are in an unknown state, and a close without them can lose
 * text. The window then shows the cause, so the author knows why it stays
 * (#57). The promise does not reject.
 *
 * @param   {ClosingWindow}         window       The window
 * @param   {string}                windowId     Its key in the documents provider
 * @param   {WindowCloseDocuments}  documents    The documents provider
 * @param   {LogProvider}           logger       The log of the application
 * @param   {Function}              permitClose  Lets the next close of the window pass
 */
export async function closeWithDocuments(
  window: ClosingWindow,
  windowId: string,
  documents: WindowCloseDocuments,
  logger: Pick<LogProvider, "error">,
  permitClose: () => void,
): Promise<void> {
  // What repeats this close after the documents provider refused it.
  const closeAgain = async (): Promise<void> => {
    window.close();
  };
  try {
    const mayClose = documents.isClean(windowId)
      ? await documents.closeWindow(windowId, closeAgain)
      : await documents.askUserToCloseWindow(windowId, closeAgain);
    if (mayClose) {
      permitClose();
      window.close();
    }
  } catch (err: unknown) {
    logger.error("[WindowManager] Could not close the window", err);
    const cause = err instanceof Error ? err.message : String(err);
    showRefusalInWindow(
      window.webContents,
      "close-window",
      new Error(trans("The window was not closed: %s", cause)),
    );
  }
}
