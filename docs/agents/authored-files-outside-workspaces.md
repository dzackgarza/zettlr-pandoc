# 21. Authored files outside the workspaces

- **What they are.** The Assets window edits files of the author that no
  workspace holds: the Lua filters (`userData/lua-filter`), the export and
  import profiles (`userData/defaults`), the snippets file and
  `userData/custom.css`. `AssetsProvider` and `CssProvider` own them.
- **A refused operation rejects.** A read, a save, a creation, a rename, a
  removal and the restore of a protected file reject with an
  `AuthoredFileError` (`app/util/authored-file-error.ts`), whose message
  names the file and the cause. No method answers `false` for a failure.
  `refusedAs(operation, path)` is the rejection handler of one filesystem
  call.
- **No file is replaced.** A new filter or profile is made through
  `create-filter` or `create-defaults-file`; a name that a file has is
  refused. A rename to the name of another file is refused, and both files
  stay. `set-filter` and `set-defaults-file` save the text of a file that the
  window read.
- **The window shows each refusal once.** A request of a window that is no
  application command shows its rejection through `showRefusal`
  (`common/util/show-refusal.ts`). The dispatcher shows the failure of a
  command ([§15](failed-commands.md)).
- **A window saves only text that it read.** A tab of the Assets window has
  the state `editable`: the editor holds the text of the selected file. It is
  false while the text loads and after a refused read; the editor is then
  empty and read-only (`CodeEditor.readonly`), and the tab sends no save,
  also for the save shortcut. A refused save leaves the text in the editor
  with the status "Unsaved changes".
- **An open that the desktop refuses rejects.** `openPath`
  (`app/util/open-path.ts`) is the one open of a path with the desktop; no
  other code calls `shell.openPath`. On Linux it starts `xdg-open` and reads
  its exit code: since electron/electron#48079 the promise of
  `shell.openPath` never settles there, and a caller that waits for it waits
  for ever. The promise of `openPath` settles when `xdg-open` ends; outside a
  desktop that `xdg-open` knows (Hyprland), that is when the author closes
  the application. A caller that has no work after the open does not wait:
  it shows the refusal in an error window that names the file (the export
  commands, a file that the app does not open itself). A command that is
  only the open waits, and its refusal is shown once: by the dispatcher
  ([§15](failed-commands.md)) or by `showRefusal` in the window that asked.
- **An address goes through `openExternal`** (the same module); no other
  code calls `shell.openExternal`. On Linux that promise resolves although
  `xdg-open` fails, so `openExternal` runs `xdg-open` as `openPath` does
  and rejects with the address and the cause.
- **Proof:** `e2e/export-open-refused.spec.ts`, `e2e/preferences-open-refused.spec.ts`,
  `e2e/follow-link-refused.spec.ts`,
  `test/menu-file-navigation.spec.ts`, `test/assets-authored-files.spec.ts`,
  `e2e/assets-refused-save.spec.ts`.
