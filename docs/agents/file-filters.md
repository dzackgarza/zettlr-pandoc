# 10. File filters

- **What the filter judges:** the gitignore rules and the file types. A
  file type is hidden when it is not in `fileManager.filters.include`
  (empty: every type), when the `files.<type>.showInFilemanager` of its
  group is off, or when it is of no known type and its extension is not in
  `attachmentExtensions`. Markdown and code files are always of a known
  type. The type of a file is read by `file-extention-checks.ts` only, and
  the case of an extension does not count (`Notes.MD`, `Paper.PDF`).
  A path with a segment that starts with `.` is a dot path, hidden
  while dot files are off; a folder is hidden by type only as a dot path.
  `IgnoreFilter.matches` judges both, `ruleMatches` the rules only (Hide
  and Unhide edit rules, so they read `ruleMatches`).
- **An extension of `attachmentExtensions` is a known extension.** It has
  three more roles than the listing: a new file whose name has it keeps
  its name (`file-new.ts`; another name gets the extension of the
  document type), a rename to it is a change of extension that the author
  confirms (`file-rename.ts`; another extension is kept as part of the
  name), and the row of such a file has the attachment icon
  (`file-group`, `TreeItem.vue`). `hasAnyRecognizedFileExtension` decides
  the first two.
- **Rules:** gitignore syntax, matched by the `ignore` package. The sources
  are `fileManager.ignoreRules` in the configuration (all workspaces) and the
  file `.zettlrignore` at the root of each open workspace. A path below
  nested roots is judged by the innermost root (`innermostRoot`). No rule hides
  a workspace root. The pure module is `source/common/util/ignore-rules.ts`
  (`createIgnoreFilter`, `ruleForName`, `ruleForPath`, `setPathIgnored`,
  `movePathRules`, `removePathRules`).
- **One filter, in the FSAL:** `fsal/util/read-directory.ts` leaves hidden
  children out of every listing, and `FSAL.isListed` drops every watcher
  event of a hidden path. The file manager, the launcher, search, the link
  index and backlinks, the lint queue and the Agent API therefore never see a
  hidden path. A new consumer lists through the FSAL; it must not walk the
  disk or filter on its own.
- **A `change` names a file or a folder.** The watchdog reports a change of
  `.ztr-directory` as a `change` of its folder, so a new sort, display or
  Project of a subfolder reaches the windows as a `change` with the folder
  descriptor. `emitChokidarEvent` drops a `change` only for a path that the
  filter hides as a file and as a folder; the descriptor then decides. A
  check that judges a `change` as a file drops each folder whose name has no
  known extension (#220). Proof: `test/fsal-watcher-events.spec.ts`,
  `e2e/explorer-metadata-sort.spec.ts`.
- **A rule change is ordinary events.** `applyIgnoreSources` compares the
  old and the new filter over each workspace (`visibilityChanges`) and
  publishes `unlink`/`unlinkDir` for each path that the rules now hide and
  `add`/`addDir` for each path that they now show. Consumers need no rule
  logic. The FSAL reads the rules again when the configuration changes or
  when the watcher reports a change of a `.zettlrignore`. An in-app rename or
  delete rewrites the path rules of that path.
- **IPC:** `fsal` commands `get-ignore-rules`, `set-workspace-ignore-rules`
  (`{ root, text }`) and `set-path-ignored` (`{ path, isDirectory, ignored }`);
  the broadcast `fsal-ignore-rules` carries the current `IgnoreRuleSources`.
- **One editor:** `win-main/IgnoreRulesDialog.vue` (the File filters window)
  holds every setting that decides what the app lists: Turn the filters off
  (`fileManager.showIgnored`), the file types (`fileManager.filters.include`,
  `files.<type>.showInFilemanager`, `attachmentExtensions`), the global rules,
  each workspace `.zettlrignore`, the project file filter of each project
  (`settings.explorer.projectFilter`) and the read-only built-in names
  (`IGNORE_PATHS`). No other surface edits these values. Preferences →
  File Manager has only a button that opens the window (`application`
  command `edit-ignore-rules`); Advanced → File Treatment and the
  onboarding page "Images and PDFs" set only "Open with", and File
  Treatment has the same button. The Workspaces header menu, the
  application menu and the launcher (`menu.edit_ignore_rules`) open the
  window. "Search files" (`menu.filter_files`) is the file name search of
  the file manager, not a filter setting. The context menus
  are actions on the same state: hide or show a path or a name
  (`file-manager/util/ignore-menu.ts`) and the project file filter of a
  project folder.
- **One evaluator.** The FSAL applies the rules, the file types and the
  built-in names to every consumer. The project file filter is the only
  other filter: a view of one project folder in the window
  (`explorer-ordering.ts`). `useIgnoreRulesStore` holds the filter sources
  and marks matches (`is-ignored`).
- **A filter hides; it does not close.** An open document that a rule or a
  file type hides stays open, and it saves to its path. The documents
  provider closes tabs through its own watcher; it reads `fsal-events`
  only to end the document ids of removed files ([§14](document-identity.md)), and a hidden file
  is on disk and keeps its id.
- **A filter does not remove a chapter.** A Project export takes each
  chapter of its settings that is a file on disk (`exportProject`), also a
  chapter that a rule or a file type hides; the message of the export names
  each other chapter with its cause. Proof: `test/project-export.spec.ts`.
- **Cost of a rule change:** one scan of each open workspace before and
  after, on asynchronous `readdir` calls. On 21,226 files in 2,312 folders a
  rule change takes about 300 ms of main-process JavaScript in short steps,
  and the window has no long task except one of under 90 ms for 2000
  removed rows (#148).
- **`fileManager.showIgnored`** turns the filters off for every consumer,
  not only for the file manager: hidden types and dot paths are listed too.
  The file manager then dims each match.
- **Proof:** `test/ignore-rules.spec.ts`, `test/fsal-ignore-rules.spec.ts`,
  `test/file-filter-preferences.spec.ts`,
  `e2e/ignore-rules.spec.ts`.
