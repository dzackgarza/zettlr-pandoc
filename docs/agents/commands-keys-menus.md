# 26. Commands, keys and menu items

- **The command registry owns each key.** `common/commands/command-registry.ts`
  gives each command its default key; `config.shortcuts` changes it. The
  application menu (`withRegisteredAccelerators`,
  `menu/registered-accelerators.ts`), the editor keymaps, the context menus
  (`context-menu/menu-accelerator.ts`), the launcher rows and the Shortcuts
  table of the Preferences read the configured key
  (`getConfiguredShortcut`). A menu template that states a key that no
  command owns is refused. A new item that runs a command takes its key
  from the registry; no surface types a key.
- **No two commands share a key.** `getCommandConflicts` compares keys in
  the normal form of CodeMirror (`Mod-C` and `Mod-Shift-c` are one key)
  across the scopes.
- **One action, one handler, from each entry point.**
  - The Insert, Format and Edit items of the context menus of the editor
    and of a table cell are the items of the application menu
    (`common/commands/editing-menu-items.ts`): the same id, label, command
    and table size. Copy during a review gives the CriticMarkup of Edit →
    Copy.
  - "Close all tabs" and "Close other tabs" are main-process commands
    (`close-all-tabs`, `close-other-tabs`). They close one tab after the
    other through `closeFile`, so the author answers about one document at
    a time and a cancel stops the rest. `closeFile` refuses a pinned tab
    before it asks or unloads. "Close other tabs" keeps the pinned tabs;
    "Close all tabs" closes them too.
  - New file and New directory ask for the name in the name field of the
    row, in the list and in the tree. A name field is keyed by the path of
    its row (`file-manager/util/name-fields.ts`), so it stays with its row
    while the rows change. The key of "Rename file" opens the field of the
    row of the active document (`openRowRenameField`).
  - Reveal in the file browser goes through the command `reveal-path`
    (`revealPath`, `app/util/open-path.ts`): it opens the folder with the
    application of the desktop and rejects with the cause.
  - "Rescan directory" runs `rescan-dir` ([§24](missing-workspace.md)); Window → New directory…
    opens the name field of the selected folder only
    (`newDirectoryRequest`).
  - Previous file and Next file go through `navigatePaneHistory`
    (`markdown-editor/util/reference-navigation.ts`) from each entry
    point: the keys in the editor, the application menu, the mouse
    buttons and the swipe (`navigateHistory` in `App.vue`). The request
    carries the place of the caret in the editor that the pane shows, so
    the opposite move restores it, and a refusal shows one message. Proof:
    `e2e/menu-navigation-auxiliary-window.spec.ts`.
  - Follow link goes through `followLinkAt`
    (`markdown-editor/plugins/click-listeners.ts`) for a Mod-click and for
    the command `nav-follow-link` (`followLinkAtCursor`: the key F12 and
    File → Follow link). It follows a plain address, a Markdown link, a
    wikilink, a tag, a cross-reference and a footnote. The command takes
    the link around the caret, else the link that starts at the caret,
    else the link that ends at it; a caret on no link leaves the key to
    the next binding. An editor gives its openers of a wikilink and a tag
    as facets (`wikilinkOpener`, `tagOpener`); an editor without them (a
    table cell) follows no such link. Proof:
    `e2e/follow-link-key.spec.ts`.
  - A chip shows that it is a link. A chip that follows a link on a
    Mod-click (a reference chip, a wikilink chip) has the pointer cursor and
    a stronger tint under the pointer. While the Mod key is down and the
    pointer is in the editor, the editor has the class `cm-link-modifier`
    (`linkModifier`, `markdown-editor/plugins/link-modifier.ts`), and the
    chip under the pointer has an underline and the link colour of the
    theme. The hover tooltip of the link names its gestures
    (`linkGestureLine`, `tooltips/link-gesture.ts`): the Mod-click, and the
    click that shows the source while the chip is drawn. A new chip that
    follows a link has the same three things. Proof:
    `e2e/chip-link-affordance.spec.ts`.
- **The contract types each command and its handler.**
  `ApplicationIPCContract` (`commands/index.ts`) names each command of the
  `application` channel with its payload and its answer. The invoke of a
  window and `CommandProvider.run` in the main process check a call
  against it. The handler map of `CommandProvider` (`ApplicationHandlers`)
  has one handler for each command of the contract. A handler takes
  `ApplicationPayload<K>` and gives the answer of the contract, so the
  contract, the callers and the handler name one set of fields. Each other
  invoke channel registers its handlers through `handleInvokeChannel`,
  `handleFixedChannel` or `handleBareChannel`
  (`app/util/handle-ipc-channel.ts`), which take their types from the
  channel tables of `ipc-bridge.ts`. A handler map without a command of the
  contract, with a command that the contract does not name, or with a
  wrong answer does not compile. A message whose command has no handler is
  an error that names the channel and the command. A new invoke channel
  goes into a table and registers through one of these functions;
  `CommandProvider` registers `application` itself, because main-process
  code runs the same handlers through `run`. A command that a provider
  channel receives through `ipcMain.on` (`get-citation-sync`,
  `abort-task`) is no invoke command, and the invoke handler of that
  channel throws for it. Proof: `e2e/file-duplicate.spec.ts`,
  `test/ipc-invoke-channels.contract.ts` and
  `test/ipc-invoke-handlers.contract.ts` (the typecheck).
- **The contract types each broadcast.** `IpcBroadcastContracts`
  (`source/types/renderer/ipc-bridge.ts`) names each channel on which the
  main process sends a window a message, with the arguments of the
  message. The table imports each type from its sender. `window.ipc.on`,
  `broadcastIPCMessage`, `sendIPCMessage`, `replyIPCMessage` and
  `tellMainWindows` check a channel and its arguments against it. A new
  sender uses one of these functions, not `webContents.send`. A new
  listener takes the arguments that the table declares, without an
  annotation. A channel with more than one message declares the union of
  its messages; `insert-table` is a channel of its own, as a shortcut is
  its name only. Proof: `test/ipc-broadcast-channels.contract.ts` (the
  typecheck).
- **A context menu has the width of its labels.** `.application-menu` has
  `width: max-content`; `positionMenu` reads that width to put the menu
  where it fits, also at the right edge of the window.
- **Proof:** `e2e/window-shortcut-keys.spec.ts`,
  `e2e/editor-context-menu.spec.ts`, `e2e/tab-close-all.spec.ts`,
  `e2e/tab-close-others.spec.ts`, `e2e/file-list-create.spec.ts`,
  `e2e/rename-one-field.spec.ts`, `e2e/reveal-in-file-browser.spec.ts`.
