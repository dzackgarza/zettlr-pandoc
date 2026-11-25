# 17. A main window without a working renderer

- **The author gets a prompt.** `recoverRenderer`
  (`service-providers/windows/recover-renderer.ts`) follows each main window.
  When Electron reports `render-process-gone`, a native message box names the
  reason and the exit code and offers "Load the window again" and "Close the
  window". When Electron reports `unresponsive`, a second box offers the same
  two actions and "Keep waiting", which is its default; the box goes away
  when the window responds again. The prompt is native because a window
  without a renderer draws nothing and takes no input.
- **The documents are in the main process.** A new renderer shows the
  unsaved text of each document. Text that a hung renderer did not send to
  its document is lost with that renderer; the prompt says so.
- **Each action but "Keep waiting" starts a new renderer first.** "Close the
  window" loads the window and then closes it on the usual path
  (`closeWindow`, [§14](document-identity.md)), so the unsaved-changes prompt runs and a cancel leaves
  a window that works.
- **A hung renderer is ended before the load.** The main process ends it
  with SIGKILL (`webContents.getOSProcessId()`), as Electron's
  `forcefullyCrashRenderer()` does on macOS and Windows. On Linux that method
  only asks the renderer to crash itself, and the renderer exits when its
  crash dump is written; a dump that does not end left the window without a
  renderer and without a prompt. The load starts when Electron reports the
  exit: a load that starts before the exit does not happen.
- **No message goes to a window without a renderer.** `broadcastIPCMessage`
  leaves out a window whose `webContents.isCrashed()`. Main-process code that
  tells every window something calls `broadcastIPCMessage`; it does not loop
  over `BrowserWindow.getAllWindows()` with `webContents.send`. Code that
  tells some main windows something calls `WindowProvider.tellMainWindows`
  (`windows/tell-main-windows.ts`), which leaves out the same windows and
  gives the message to the main window that the author used last when no
  addressed window can take it. A window reads the whole state when it
  loads.
- **Other windows.** `attachLogger` records the reason for each window. Only
  main windows have the prompt.
- **Proof:** `e2e/renderer-recovery.spec.ts` (a killed renderer, a renderer
  in an endless loop, and a close of a stopped window). It answers native
  message boxes, so it runs through the lanes only ([§13](e2e-runs.md)).
