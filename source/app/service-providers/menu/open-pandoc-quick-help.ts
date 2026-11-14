import { type IpcMessageTarget, sendIPCMessage } from "@common/util/broadcast-ipc-message";

interface ShortcutTarget {
  webContents: IpcMessageTarget;
}

/** Opens the Pandoc quick reference in the focused main window. */
export default function openPandocQuickHelp(focusedWindow?: ShortcutTarget): void {
  if (focusedWindow !== undefined) {
    sendIPCMessage(focusedWindow.webContents, "shortcut", "pandoc-quick-help");
  }
}
