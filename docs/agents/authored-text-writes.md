# 16. Writes of authored text files

- **One writer.** `writeTextFile` (`fsal/util/write-text-file.ts`) writes each
  text file that the author owns: a document (`FSAL.writeTextFile`: a save,
  `save-copy`, a duplicate; the closed files of a workspace edit ([§28](multi-document-edits.md)),
  its rollback and its startup recovery in `workspace-edit-transaction.ts`), a
  Quarto manifest, `.zettlrignore`, `.ztr-directory`, the custom CSS, a
  defaults file, a Lua filter, the snippets, the user dictionary, the prose completion file and a figure
  of the central figures directory (its bytes, through the Agent API). A new
  path that writes such a file calls it, and does not call `fs.writeFile` or
  `write-file-atomic`.
- **A creation replaces no file.** `createTextFile` (the same module) makes a
  file only at a path that no file has, in one step of the filesystem. A new
  path that makes a file under a name of the author calls it.
- **A reader gets whole text.** The text goes to a temporary file beside the
  target, and a rename puts that file in the place of the target
  (`write-file-atomic`). A reader gets the text before the write or the text
  after it. A write that stops leaves the text before it.
- **In place where a rename would change what the file is.** A symbolic link,
  a file with a second hard link, a file of another user or of a group that
  the user cannot set, and a file in a directory without write permission are
  written in place: the rule of the value `auto` of Vim's `backupcopy`. A
  reader of such a file can get a part of the text.
- **The permission of the file decides.** A file without write permission
  refuses the write (`EACCES`), also in a directory that the author may write.
- **The file is a new inode.** The new file has the mode, the owner and the
  group of the old one. It does not have its extended attributes or its ACL:
  Node has no interface to them.
- **The watcher reports a change.** The rename arrives as `change` for the
  file and never as `unlink`; the documents provider closes the tabs of a
  removed file whose document has no unsaved text ([§14](document-identity.md)). The temporary file `<name>.<number>` gets `add` and `unlink`
  events. It is of no known type, so the file filters hide it ([§10](file-filters.md)).
- **Proof:** `test/fsal-write-text-file.spec.ts`, `test/central-figures-store.spec.ts`,
  `test/fsal-watcher-events.spec.ts`, `e2e/save-after-typing.spec.ts`,
  `e2e/refused-save.spec.ts`.
