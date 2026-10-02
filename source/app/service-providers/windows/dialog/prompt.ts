/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        promptDialog
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Prompts the user with some information
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type LogProvider from "@providers/log";
import { type BrowserWindow, dialog, type MessageBoxOptions } from "electron";

/**
 * What a prompt shows. Every caller names the kind of the message and its
 * title.
 */
export interface PromptOptions {
  type: NonNullable<MessageBoxOptions["type"]>;
  title: string;
  message: string;
}

/**
 * Displays a prompt with information
 *
 * @param   {BrowserWindow|null}  win      The window to attach to
 * @param   {PromptOptions}       options  What the message box shows
 */
export default function promptDialog(
  logger: LogProvider,
  win: BrowserWindow | null,
  options: PromptOptions,
): void {
  const boxOptions: MessageBoxOptions = {
    type: options.type,
    buttons: [trans("Ok")],
    defaultId: 0,
    title: options.title,
    message: options.message,
  };

  // The showmessageBox-function returns a promise,
  // nevertheless, we don't need a return.
  // DEBUG: Trying to resolve bug #1645, which seems to relate to modal status
  // vs. promise awaits. UPDATE 2024-03-11: In response to #4952, removing the
  // platform check again.
  if (win !== null) {
    dialog
      .showMessageBox(win, boxOptions)
      .catch((e) => logger.error("[Window Manager] Prompt threw an error", e));
  } else {
    dialog
      .showMessageBox(boxOptions)
      .catch((e) => logger.error("[Window Manager] Prompt threw an error", e));
  }
}
