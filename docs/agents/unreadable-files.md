# 19. A file that cannot be read

- **The file has a descriptor.** A workspace file whose text the filesystem
  refuses to read (`EACCES`, `EIO`) is listed. Its Markdown or code
  descriptor carries `readError` (the code and the message of the error);
  the other fields describe a file without text. The parsers read through
  `readFileText` (`fsal/util/read-file-text.ts`). A path that is gone still
  rejects. One such file does not stop the index of its workspace or the
  start of the app.
- **The descriptor is not cached.** Each request for it reads the file
  again. The FSAL logs the cause one time, and publishes `change` for the
  file when its read state changes: the watcher does not report a change of
  permissions.
- **The file manager shows the cause.** A row of such a file has the warning
  icon, the attribute `data-read-error` and the cause in its title
  (`file-manager/util/read-error.ts`).
- **A document without text is a document that was not linted.**
  `DocumentLintSource` is a text or the cause (`unreadable`). The Problems
  view, the Fix All plan and `/v1/lint` (scopes `workspace` and `all`, kind
  `unreadable` in `failed`) name the document and answer for the other
  documents. No failure is kept for it: each reader reads the file again.
- **A document that Flowmark cannot lint keeps its cause.**
  `DocumentLintProvider` keeps the last run of each document that gave no
  result, for the session. The queue does not lint the same text with the
  same inputs again. The Problems view and `/v1/lint` (`failed`, and
  `queueStopped` while the background queue lints no document) name each
  such document with the cause. "Try again" in the Problems view runs the
  command `retry-workspace-lint` (`DocumentLintProvider.retry`).
- **A check that did not run is one diagnostic.** A lint provider of the
  editor that rejects gives the error diagnostic "This check did not run:
  <cause>" (`external-linter-adapter.ts`). The status bar counts follow each
  transaction that sets diagnostics.
- **A failed first load offers the load again.** The message of an editor
  that could not load its document has the action "Try again"
  (`surface-document-load-error.ts`, `loadAgain` in `MainEditor.vue`).
- **A search reads the other files.** The workspace search
  (`service-providers/search`) does not stop at a file that it cannot read
  or at a folder that it cannot list. It names each such file and folder
  (`kind`) with the cause: the broadcast `search-unread` for the Search
  view, which lists them above the results, and the list `notSearched` of
  `GET /v1/workspace/search`. The preview of Replace All
  says that those files keep their text. An error that is no filesystem
  error ends the search with the failure `stopped`, which names the file.
- **A walk names the folders that it could not read.**
  `FSAL.readDirectoryRecursively` gives a `DirectoryListing`: the paths,
  and in `notListed` each folder whose content the filesystem refused, with
  the cause. A refused folder is in `paths` too. The walk of a missing
  workspace ([§24](missing-workspace.md)) gives its root and its causes, and no other path. The
  Agent API workspace listings (`include=files`, `documents`,
  `directories`) answer 200 with `notListed`; a root that refuses its
  content is a listing with no files and the root in `notListed`.
- **A folder whose metadata cannot be used is listed.** The descriptor of
  a folder names each such thing in `metadataProblems` (source, path,
  message): a `.ztr-directory` that cannot be read, is not JSON or does not
  hold settings (`settings`); a Quarto manifest that cannot be read or
  parsed, and a bound manifest that is absent or describes no book
  (`manifest`); a folder that refuses its content (`directory`). The folder
  has the default settings and no Project. The manifest of a Quarto project
  that is no book is no problem of a folder without a binding. One such
  folder does not stop the index of its workspace or the start of the app,
  and a folder that refuses its content is a path of its workspace.
- **A load of a folder changes nothing on disk.** `parseSettings`
  (`fsal-directory.ts`) leaves the settings file as it is. A change of the
  settings of a folder whose settings file could not be read throws
  `DirectorySettingsUnreadableError`, so no write replaces what the author
  set; the dispatcher shows the message ([§15](failed-commands.md)).
- **The row and the properties of the folder show each cause**
  (`file-manager/util/read-error.ts`, the attribute
  `data-metadata-problem`). The properties offer the removal of a binding
  whose manifest gives no book.
- **A control of the folder properties shows the saved state.** After a
  refused change the sort controls and the Project switch show what the
  folder has (`PopoverDirProps.vue`). The controls send a command only for a
  choice of the author: the open of the properties writes nothing.
- **A change of a manifest is a change of its folder.** The FSAL keeps the
  manifest location of each bound folder and publishes `change` for the
  folder when its manifest is added, changed or removed.
- **Proof:** `test/fsal-unreadable-file.spec.ts`,
  `test/document-lint-failure.spec.ts`, `test/agent-http-api.spec.ts`,
  `test/external-linter-adapter.spec.ts`, `e2e/lint-failure.spec.ts`,
  `e2e/document-load-retry.spec.ts`, `e2e/search-replace.spec.ts`,
  `test/fsal-directory-metadata.spec.ts`,
  `e2e/folder-metadata-problems.spec.ts`.
