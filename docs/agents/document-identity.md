# 14. Document identity and refused closes

- **The id of a document moves with its path.** `DocumentManager`
  (`service-providers/documents/index.ts`) keeps the path of each id and the
  id of each path. A rename or a move goes through `hasMovedFile` or
  `hasMovedDir`, which move the id, the loaded document, its tabs and its
  collaboration state under the document lock (`_movePathOfDocument`, then
  `renameCollaboration`). A new transition that changes the path of a
  document goes through them; it must not assign a new id to the new path.
- **An id lasts while the app can name its path.** A listing of the Agent
  API gives an id to each file of a workspace (`ensureDocumentId`). The id
  goes when the FSAL reports the removal of a file that no loaded document
  and no tab holds, when the last holder of a removed file closes
  (`syncWatchedFilePaths`), and when its workspace closes
  (`closeDocumentsInside`). The maps of ids follow the files that exist.
  Proof: `test/document-id-lifetime.spec.ts`.
- **The sidecar follows the file.** The sidecar of a closed document moves
  with the file too: `hasMovedDir` reads `listCollaborationSidecars()` for the
  documents that are not loaded. A document whose file a move replaced is
  dropped with its tabs, its state in memory and its sidecar
  (`_dropReplacedDocument`).
- **Collaboration state in memory belongs to a loaded document.** A document
  that a refused proposal loaded and released has no state in memory.
- **No close and no reload is refused without an action.** A close of a
  tab, a window close, a quit and a reload from disk (`notifyRemoteChange`)
  detach the collaboration state through `_detachForClose`. When the sidecar
  cannot be written, it records how to repeat that action and sends
  `save-refused` with `refused: { documentId, action }`. The window shows
  the cause with the action "Close anyway", "Load from disk anyway" or
  "Quit anyway" (`win-main/util/refused-action-text.ts`), which sends
  `close-without-review`. `closeWithoutReview` drops the state in memory,
  leaves the sidecar as it was last written, and repeats the action. A new
  path that closes or reloads a document detaches through
  `_detachForClose`.
- **A message about a document goes to the window that it concerns.**
  `_tellAbout` sends each message of the provider about one document (a
  refused close or save, a removed file that stays open, a change on disk
  that the editor did not take, an unreadable sidecar). The window that
  started the action gets it. When no window started it (a quit, an
  autosave, a watcher event), each main window whose panes show the
  document gets it. When no pane shows the document, the main window that
  the author used last gets it. A window that only shares the application
  with the document shows nothing. A new message about one document goes
  through `_tellAbout`; `broadcastIpcMessage` of the provider is for state
  that each window keeps (`documents-update`).
- **The message of a refused quit says what its action does.** The quit
  stops at one document, and "Quit anyway" changes that document: its
  review stays as the sidecar last held it, or the document closes without
  its unsaved text. The provider writes that sentence after the cause
  (`REVIEW_NOT_SAVED`, `CHANGES_NOT_DISCARDED`).
- **A refused save has a reason and names its cause.** `SaveFileResult` is
  `{ ok: true }` or a `SaveRefusal` (`types/common/documents.ts`); no save
  answers a bare `false`. The window shows the message of the refusal
  (`save-buffer.ts`, `App.vue`). A refusal that the disk version resolves
  (`disk-changed`) and a failed reload of a changed file offer "Load from
  disk" (`common/util/load-document-from-disk.ts`). A refusal that leaves
  text which cannot reach its file (`write-failed`, `disk-unreadable`,
  `review-not-persisted`) offers "Save a copy…"
  (`common/util/save-refusal-action.ts`): the command `save-copy` writes the
  text of the document to a file that the author chooses, and the document
  stays unsaved.
- **The answer "discard" at a close prompt goes through `_discardForClose`.**
  A discard that fails (the sidecar cannot be written, the file cannot be
  read) is a refused close with the same action. `closeWithoutReview` then
  closes the tabs of the document and unloads it: its buffer is the text
  that the author threw away.
  A discard goes back to the file; when another program removed the file,
  it goes back to the text that the app last read from it or wrote to it,
  and the close goes on. Proof: `test/documents-removed-file.spec.ts`.
- **A discard changes only the state in memory.** `discardCollaboration`
  does nothing for a document with no review and no annotations in memory.
  The sidecar of such a document is the state of another time (the author
  closed the document without it, or this version cannot read the file),
  and the discard leaves the file as it is.
- **A delete in the application moves the review state aside.**
  `file-delete` and `dir-delete` close each document at or inside the path
  (`closeDocumentsForDelete`; a refused close keeps the file), remove the
  path, and then move the sidecar of each such document aside
  (`setAsideStateOfDeleted`): a new file at the path of a deleted document
  opens without its annotations and its review, and the bytes stay in the
  sidecar directory. A new command that deletes authored files does the
  same. Proof: `test/collaboration-sidecar-of-no-document.spec.ts`.
- **A sidecar whose document has no file is named.** A document that
  another program removed keeps its sidecar: a file that comes back at the
  path can be the same document (a checkout). A move that cannot write the
  sidecar at the new key leaves it at the old one. `_sidecarsOfNoDocument`
  gives each such
  file in `WorkspaceCollaborationListing.ownerless`: a readable sidecar of a
  path inside an open workspace that is there, where the application
  reaches no file and no loaded document has the path. The Annotations
  view shows it with the action "Move the file aside". A sidecar of a path
  outside every open workspace is not named.
- **`closeWindow` answers whether the window may close.** The window
  provider closes the `BrowserWindow` only for `true`, and gives the
  documents provider the function that repeats the close. The window
  provider does this in `closeWithDocuments`
  (`windows/close-with-documents.ts`). A close that rejects keeps the
  window and shows "The window was not closed: <cause>" in it; the window
  is never closed without its documents. Proof:
  `test/window-close-with-documents.spec.ts` (each answer of the documents
  provider, and a rejection), `e2e/window-close.spec.ts` (the real
  provider).
- **`closeFileEverywhere` answers whether the document closed.** It
  detaches before it closes a tab, so a refused close leaves the tabs and
  the buffer. A caller that removes the file afterwards (`file-delete`, the
  overwrite of `file-new`) stops on `false`.
- **The close of a root is a close of its documents.** The command
  `root-close` takes the list of roots (workspaces and root files) that one
  action of the author closes: a row, "Close all workspaces", "Close all
  files". It calls `closeDocumentsInside` before it removes the roots. That
  asks one time about the unsaved text of the documents at or inside the
  roots that no other open root holds, as the close of a window does, and
  closes each such document and tab, also of a path that the file filters
  hide. A document of a nested workspace that stays open stays open too. A
  refused or cancelled close keeps each root. A new action that closes
  roots sends them in one `root-close`. Proof:
  `e2e/close-workspace.spec.ts`, `e2e/close-roots.spec.ts`,
  `test/documents-close-workspace.spec.ts`.
- **A sidecar that cannot be read is kept.** `CollaborationSidecarStore`
  replaces or removes a file only after its last read of that file gave a
  sidecar or no file (`examined`). A file that this version cannot read (a
  later schema, damaged bytes) refuses each write of its document, so a new
  annotation is refused with `PERSISTENCE_FAILED` and the bytes stay.
  `inventory()` gives the readable sidecars and names each unreadable file
  with its cause; the Annotations view and a message at the open of the
  document show the file with the action "Move the file aside"
  (`set-aside-collaboration-sidecar`), which renames the file in the sidecar
  directory and keeps its bytes. `list()` is the complete set or an error.
  A read of such a file and `list()` reject with
  `CollaborationSidecarUnreadableError`, which the Agent API answers with
  409 `COLLABORATION_STATE_UNREADABLE` and that action. The Agent API
  listings reject while an unreadable file exists; the lookup of an
  annotation of a loaded document and the read of another closed document
  do not read that file (`test/annotation-agent-api.spec.ts`).
- **A sidecar that a load cannot write is not an unreadable sidecar.** A
  load attaches the sidecar to the text of the file, and that attach can
  write it (a new fence, orphaned annotations). When the write fails, the
  document opens without the sidecar and its window gets
  `COLLABORATION_FILE_UNWRITABLE_CHANNEL`: a message that names the write,
  with no "Move the file aside" (the move is a write too). The next load
  attaches the sidecar again. Only `CollaborationSidecarUnreadableError`
  is an unreadable file (`_reattachCollaborationSidecar`); any other
  rejection propagates. Proof: `e2e/review-persistence-failure.spec.ts`
  (#218).
- **A prompt for many documents does not decide a review.** A quit and a
  window close ask the author to save or discard only the documents of
  `_documentsToAskAbout`. A document whose review has an undecided proposal
  (`_holdsUndecidedProposal`) is not one of them: its working text holds the
  proposal, so a save would write the proposal to the file and a discard
  would destroy the review. Its text and its review are in the sidecar, and
  the next load of the document attaches them. The quit prompt names such a
  document after the ones it asks about (`_quitPromptDetail`). Text that the
  author accepted from a review is text of the author: the quit asks about
  it, also for a document that no pane shows. A save that the author starts
  for one document is not changed by this rule.
- **Each edit of a loaded document goes through the collaboration service.**
  The update of an editor (`pushUpdatesLocked`) and a workspace edit
  (`applyWorkspaceTextEdits`) commit through `applyWorkingTextEditLocked`,
  which maps the annotations and the review through the change and writes
  the sidecar before the buffer takes the text. A new path that changes the
  text of a loaded document commits through it. The rollback of a workspace
  edit transaction applies the inverse of its edits (`inverseEdits`), so an
  annotation and a review return to their places; it does not replace the
  buffer with the old text.
- **A stopped workspace edit is undone in the sidecars too.** A workspace
  edit writes a journal before it changes a file or a buffer
  (`workspace-edit-transaction.ts`). The removal of the journal is the
  commit: an edit that cannot remove its journal is rolled back and
  rejects. When the app stops before the journal is removed, the next start
  (`ReferenceProvider.boot`) gives the original back to each closed file of
  the journal that holds the text of the edit; a file with other text is
  text of the author and stays. It gives the document authority the inverse
  of the edits of each open document (`restoreStoredWorkingText`). The
  authority applies it to the working text of the sidecar and maps the
  review and the annotations through it, so the document loads with the
  text, the proposals and the anchors that it had before the edit. Proof:
  `test/documents-edit-collaboration.spec.ts`,
  `test/reference-rename-atomicity.spec.ts`.
- **A restored session goes out after the buffer has its text.**
  `reattachCollaboration` broadcasts nothing. `_reattachCollaborationSidecar`
  applies the working text of the sidecar and then broadcasts the state. The
  window keeps the session that it gets for a document, and an editor shows a
  review only while its text is the working text of that session.
- **A late removal closes no other document.** A rename over a file moves
  that file to the trash and then renames; when more than 100 ms pass
  between the two, the watcher reports `unlink` for the replaced path
  before the rename, and `hasMovedFile` can put the renamed document at the
  path while the close of the replaced one writes its sidecar.
  `closeFileEverywhere` closes the tabs and the buffer under the lock of the
  document that it closes, and only while the path still names that
  document. Proof: `test/documents-removed-file.spec.ts`.
- **A removed file closes only a document whose text is on disk.** The
  watcher reports the removal of the file of a tab (`unlink`). A document
  without unsaved text closes with its tabs. A document with unsaved text
  stays loaded with its tabs, and each window that shows it gets one
  message (`FILE_REMOVED_KEPT_CHANNEL`): a save writes the file again, or, for a
  document with a review, the save is refused and the message offers
  "Save a copy…". The watcher follows the path through the removal: a
  file that is written again arrives as `add`, which the provider handles
  as a change (the `add` of its own save is not a change).
- **Accepted text of a closed document stays when its file changes.** The
  sidecar of a closed document holds the text that the author accepted from
  a review and did not save. When another program changed the file before
  the next load (`driftedCollaboration`), the document loads with that text,
  as an open document keeps its text (`REMOTE_CHANGE_KEPT_CHANNEL`):
  the review is frozen, the annotations keep their anchors, the window gets
  the message of a kept change, and a save is refused with `disk-changed`
  until the author loads the file or reapplies or discards the review. A
  review with a proposal opens on the file. A kept change of a document with
  a review (`RemoteChangeKeptBroadcast.frozenReview`) offers "Load from
  disk", "Show the review" and "Save a copy…". While the document is closed,
  the Annotations view names it (`WorkspaceCollaborationListing.unsaved`: a
  sidecar with a review whose working text is not the text of its fence) and
  offers to open it. Proof: `test/documents-quit-with-review.spec.ts`,
  `e2e/accepted-text-of-closed-document.spec.ts`.
- **The provider watches the file of each loaded document.** The watcher of
  the documents provider follows the paths of the tabs and of each loaded
  document (`syncWatchedFilePaths`, called at each load and unload). A
  review loads a document that no tab shows, and a change of its file
  freezes the review and sends the message of a kept change as for a
  document in a tab. Proof: `e2e/accepted-text-of-closed-document.spec.ts`.
- **A reload keeps the place of the author.** A load into an editor that
  shows its document (`MarkdownEditor.loadDocument`: a change on disk, "Load
  from disk", a setting that makes the extensions again) maps the caret, the
  scroll position and the folds through the changes from the shown text to
  the new text, and leaves the focus where it is. `boundedChangesBetween`
  (`common/util/text-changes.ts`) gives the changes: a line diff, then a
  character diff in each replaced run of lines, each with a fixed limit of
  edits; above the limit of the line diff each place goes to the start of
  the text. A program that writes an open document again and again (a
  recorder of a conversation) therefore does not move the view and does not
  take the keys of the author. Only the first load of an editor takes the
  focus. Proof: `e2e/remote-change-keeps-place.spec.ts`,
  `test/text-changes.spec.ts`.
- **"Close anyway" at a window close offers no proposal for a save.** The
  buffer of a document with an undecided proposal takes the text of the
  file; the review and its working text stay in the sidecar. `pullUpdates`
  tells only an editor whose pane shows the path to load its document
  again, so the editor of a closing window does not load the document a
  second time. `closeWindow` removes a window only when none of its
  documents is loaded.
- **A move finishes when its review state cannot follow.** A rename, a move
  and a folder rename move each document id and offer the link update when
  the sidecar cannot be written at the new key. The author gets one message
  that names the file and the cause; the sidecar stays at the old key, where
  the Annotations view names it.
- **A save whose file cannot be read again is refused.** The reason is
  `saved-not-refreshed`: the text is on disk, the document keeps the
  descriptor of its last read, and the message names the cause.
- **A message has a list of actions.** `showToast` takes each action of a
  message (`ToastAction`), and the notification center shows the same list.
  A save that is refused because the file changed on disk under a review
  offers "Load from disk" and "Show the review", which opens the
  Annotations view (`common/util/save-refusal-action.ts`).
- **The window owns the message of a changed file that cannot be read.**
  `App.vue` shows one message with "Load from disk" for the document, not
  one for each pane or tab that shows it.
- **A save always has a document.** The editor that holds the focus saves.
  When no editor of the window holds it (the focus is on a message, in the
  file manager or in a sidebar), the save is for the active document of the
  pane that the author used last (`savesThisDocument` in `MainEditor.vue`).
- **A save writes only text that the document holds.** `saveBuffer` waits
  until the document authority took each change of the editor
  (`whenAuthoritySynced`). The wait follows the collab session of its start
  (the client id): when the editor loads the document again before the
  authority took the changes, the changes are gone with the old state, and
  the save is refused with that cause. Proof:
  `test/editor-authority-sync-guard.spec.ts`.
- **A refused action of the Annotations view is shown.** An action of the
  view on one document ("Resolve all", "Clear resolved", "Accept all", the
  recovery of a review) that the main process rejects shows the cause with
  the name of the document. An action on each document of the workspace
  goes on after a refused document and shows each refusal
  (`WorkspaceBulkOutcome`, `pinia/document-collaboration-store.ts`). Proof:
  `e2e/annotation-bulk-refused.spec.ts`.
- **Proof:** `test/documents-move-identity.spec.ts`,
  `test/documents-removed-file.spec.ts`,
  `e2e/external-delete-unsaved.spec.ts`,
  `test/documents-quit-with-review.spec.ts`,
  `test/documents-edit-collaboration.spec.ts`,
  `e2e/quit-with-open-review.spec.ts`,
  `test/documents-refused-close.spec.ts`,
  `test/documents-refused-save.spec.ts`, `test/save-refusal-toast.spec.ts`,
  `test/unreadable-collaboration-sidecar.spec.ts`,
  `test/collaboration-sidecar-of-no-document.spec.ts`,
  `test/collaboration-sidecar.spec.ts`,
  `e2e/rename-annotated-document.spec.ts`,
  `e2e/review-persistence-failure.spec.ts`, `e2e/refused-save.spec.ts`,
  `e2e/refused-save-changed-on-disk.spec.ts`, `e2e/window-close.spec.ts`,
  `e2e/reload-failure.spec.ts`, `e2e/move-with-unwritable-review-state.spec.ts`,
  `test/fsal-watcher-events.spec.ts`.
