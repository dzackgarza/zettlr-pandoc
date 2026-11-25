# 28. Edits of several documents

- **The author sees each edit first.** A command that changes the text of
  documents that the author did not open for the change (a move or a rename
  of a file or a folder with links to it, a tag rename) makes a proposal and
  changes nothing. `proposalOf` (`app/util/workspace-edit-proposal.ts`) gives
  the edits that make each document its new text and the hash of the text it
  read. `CommandProvider.propose` sends the proposal to the window that
  started the command, which shows `WorkspaceEditPreviewDialog.vue`
  (`common/vue`, through `WorkspaceEditProposals.vue`): each document, in the
  order of a file tree, and each changed run of lines before and after. A new
  command of that kind proposes too; it does not write a file.
- **Apply is one transaction.** `apply-workspace-edit`
  (`commands/workspace-edit.ts`) runs `applyWorkspaceEdit`: the journaled
  transaction (`references/workspace-edit-transaction.ts`) refuses the whole
  edit when a document changed after its hash was taken, rolls back each
  document when a file cannot be written, and then saves each open document
  that it changed. Cancel, Escape and a click outside the dialog drop the
  proposal. A proposal goes away with its window.
- **A move changes each link to the moved file.** `retargetProposal`
  (`LinkProvider`, `common/util/replace-links.ts`) rewrites a wikilink and a
  Markdown link to a file (`[text](./file.md)`, a link reference
  definition) whose target is the moved file.
- **The reference rename uses the same dialog.** `MainEditor.vue` shows the
  rename of a reference key with the old and the new key. Its apply goes
  through `ReferenceProvider`, leaves the open documents unsaved and offers
  Undo; a rejected or failed rename gives back the key that the author typed.
- **A value that a window sends over IPC is no deep reactive proxy.** The
  structured clone of IPC refuses a Vue proxy ("An object could not be
  cloned"). A window keeps an IPC payload in a `shallowRef` or sends
  `toRaw` of it.
- **Replace All of the Search view uses the same dialog.** The command
  `preview-replace` of the search provider gives the changed lines, and
  `replace-in-files` applies; both make their edits in `replacePlan`, from
  the spans of the search and the hash of the text that the search read, so
  a document that changed after the search is refused. The replace of one
  file or one match from its row has no dialog: the row shows its
  replacement before the click. A replace keeps one Undo in the view.
- **Fix All shows its plan in its own dialog**, by rule and by document
  ([Debugging entry points](debugging-entry-points.md#debugging-entry-points)), and applies through `applyWorkspaceEdit`.
- **Proof:** `e2e/link-update-preview.spec.ts`, `e2e/rename-tag.spec.ts`,
  `e2e/search-replace.spec.ts`,
  `e2e/reference-rename-preview.spec.ts`, `e2e/wikilinks.spec.ts`,
  `e2e/move-with-unwritable-review-state.spec.ts`,
  `test/workspace-edit-proposal.spec.ts`, `test/replace-links.spec.ts`.
