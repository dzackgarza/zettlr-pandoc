# 24. A workspace whose folder is missing

- **A folder that does not exist leaves the configuration.** At start the
  config check (`rootPathsOnDisk`, `config/root-paths.ts`) removes a
  workspace or an open file whose path gives `ENOENT`.
- **A folder that the filesystem cannot examine stays.** A failed mount or a
  parent folder without search permission (`EACCES`) is not a removed folder.
  The workspace stays in the configuration, and the FSAL lists it as missing
  (`deadWorkspaces`): a root descriptor with `dirNotFoundFlag`, no children,
  no watcher, no ignore rules. The other workspaces load. An open file that
  cannot be examined stays in the configuration and is not loaded.
- **A workspace whose rules file cannot be read is missing too.** Without its
  `.zettlrignore` the FSAL does not know which paths the author hid ([§10](file-filters.md)), so
  it lists none of them. Each missing workspace keeps its causes in
  `deadWorkspaces`; its root descriptor has them in `metadataProblems`
  (source `directory` or `rules`), and the row shows them ([§19](unreadable-files.md)). A rules file
  that becomes unreadable while the app runs does the same at the next read
  of the rules (`readIgnoreSources` → `loseWorkspace`: `unlink` for each
  listed path, `change` for the root), so a rule change of another workspace
  still applies.
- **The rules file of a missing workspace is not written.** Its text is not
  known, so `editRulesFiles` refuses a change for it, and the File filters
  window shows the cause in place of its field.
- **"Check for directory …" loads it.** The context menu item
  (`menu.rescan_dir`) runs the command `rescan-dir`, which calls
  `FSAL.loadMissingWorkspace`. While the folder cannot be read, the command
  throws with the cause, and the dispatcher shows it ([§15](failed-commands.md)); so does a rules
  file that still cannot be read. When both can be read, the FSAL watches the
  folder, applies its rules, and then publishes `addDir` and `add` for each
  listed path, so each window shows the workspace with its files and no path
  that a rule hides.
- **A row has the children of the item that it shows now.**
  `useItemChildren` (`file-manager/util/item-children.ts`) owns the children
  of the item of a row, for the list (`FileItem.vue`) and for the tree
  (`TreeItem.vue`). The list keeps its rows while the folder that it shows
  changes: the scroller gives a row the item of another path. A new path
  ends the old subscription and empties the children. A row of a folder
  follows the folder (`followChildren`) before it reads it, so a row whose
  first read gives nothing still shows the children that a later event
  adds. A row of a file follows nothing and reads nothing. An answer is for
  the row only while no later read started. A read that fails is in the log
  as `[File manager]`. A new row component gets its children from
  `useItemChildren`. Proof: `e2e/file-list-row-children.spec.ts`.
- **The tree shows the active document at the start.** The window opens
  each folder from the workspace to the active document of a pane
  (`maybeUncollapseDirectories`, `pinia/document-tree-store.ts`). It takes
  the workspaces from the configuration: the workspace store has them only
  after it read their files, which can be after the window got its active
  document. Code that needs the workspace of a path while the window starts
  reads the configuration. Proof: `e2e/tree-reveals-active-document.spec.ts`.
- **One listener for the rows of a window.** `followChildren`
  (`file-manager/util/follow-children.ts`) has the one `fsal-events`
  listener of the file manager; it calls the rows of the parent folder of
  each event, once for each batch. A row adds no IPC listener of its own: the
  cost of a batch follows its events, not the rows. A shortcut for a row
  goes through the `shortcut` listener of `FileManager.vue`: "New
  directory…" sets `newDirectoryRequest`
  (`file-manager/util/new-directory-request.ts`) to the selected folder, and
  only the row of that folder opens its name field. Proof:
  `e2e/file-tree-listeners.spec.ts` (the listener count of each channel,
  read from the `ipcRenderer` of the preload through CDP).
- **Proof:** `e2e/missing-workspace.spec.ts`,
  `e2e/unreadable-workspace-rules.spec.ts`,
  `test/fsal-deleted-directory.spec.ts`.
