interface ShortcutTarget {
  webContents: {
    send: (channel: string, shortcut: string) => void;
  };
}

/** Opens the Pandoc quick reference in the focused main window. */
export default function openPandocQuickHelp(focusedWindow?: ShortcutTarget): void {
  focusedWindow?.webContents.send("shortcut", "pandoc-quick-help");
}
