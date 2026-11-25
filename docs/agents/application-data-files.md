# 22. Data files of the application

- **What they are.** The application keeps its state in files of `userData`:
  `config.json`, `tags.json`, `targets.json`, `stats.json`, `documents.yaml`
  and `window_state.yml`. A `PersistentDataContainer`
  (`common/modules/persistent-data-container`) holds each one in memory and
  writes it one second after its last change.
- **A write that fails is shown.** The constructor of a container requires a
  `StoreWriteFailureHandler`. In the app it is `showStoreWriteFailure`
  (`app/util/show-store-write-failure.ts`): it logs the failure and opens one
  error window that names the file and the cause. The data stays in memory,
  so the change holds until the application closes. A new container gets the
  same handler; a spec gives `unexpectedStoreWriteFailure`
  (`test/store-write-failure.ts`), which stops the spec.
- **The user dictionary has the same handler.** `DictionaryProvider` writes
  `user.dic` through `writeTextFile` at each added word. A failed write
  releases the file lock, goes to `showStoreWriteFailure`, and the next word
  writes the whole dictionary again.
- **A refused setting is shown at its field.** The config provider checks
  each value against the rule of its setting (`config-validation.ts`) and
  keeps the old value for a refused one. The Preferences window writes a
  field through `submitFormValue` (`pinia/config.ts`), which answers the
  reason, and `FormBuilder` shows it under the field (`refusals`) until the
  field gives a value that the rule accepts. Code that writes a setting it
  built itself calls `setConfigValue` or `setConfigFromForm`, which throw.
- **A setting that a window writes is plain data.** An item of the
  configuration store (`useConfigStore().config`) is a reactive proxy, and
  the IPC of the setting cannot clone a proxy ("An object could not be
  cloned"). A new value that keeps items of the old one (an array of
  objects) builds each item again from its fields; an array of strings needs
  nothing. The export launcher remembers the profile of each document this
  way (`rememberExportProfile`, `launcher/CommandLauncher.vue`): with the
  items of the store, each export after the first one of another document
  stopped before it started and showed nothing. Proof:
  `e2e/pdf-export.spec.ts` ("exports a second document from the launcher").
- **A mode of a window writes no setting.** Distraction-free mode is a
  state of one window (`distractionFreeMode`, `pinia/window-state-store.ts`):
  it hides the panes and leaves `window.fileManagerVisible` and
  `window.sidebarVisible` as the author set them, so a quit in the mode
  keeps the arrangement of the author. A pane is shown when its setting is
  on and the window is not in the mode (`navigationSidebarShown`,
  `annotationPanelShown`). Code that shows or hides a pane calls
  `setPaneVisible`; a shown pane ends the mode.
- **An option of one start writes no setting.** A start with
  `--launch-minimized` opens no window, and its session stays in the
  notification area when its last window closes; `system.leaveAppRunning`
  stays as the author set it. `WindowProvider.keepsSessionRunning` decides
  for the close of the last window, `window-all-closed` and the tray icon,
  and a desktop without a notification area keeps no session. A click on
  the tray icon and a second start call `WindowProvider.activate`, which
  opens the windows of the session.
- **Proof:** `e2e/settings-write-refused.spec.ts`,
  `e2e/preferences-refused-value.spec.ts`,
  `e2e/user-dictionary-write-refused.spec.ts`,
  `e2e/distraction-free-restart.spec.ts`, `test/save-refusal-toast.spec.ts`,
  `e2e/launch-minimized.spec.ts`.
