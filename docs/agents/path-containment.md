# 11. Path containment

- **One owner.** `source/common/util/renderer-path-polyfill.ts` decides whether a
  path is in a directory: `isInsideRoot` (strictly inside, at a path-segment
  boundary), `isAtOrInsideRoot`, and `innermostRoot` (of the directories that hold
  a path, the longest). `/notes/book-notes.md` is not in `/notes/book`.
- **No `startsWith` on a path.** A new decision of the workspace, the Project or
  the directory of a path calls one of those three functions. A workspace inside
  a workspace is a supported state: each consumer (the link index, search, the
  Agent API workspace id, the ignore rules, the launcher, the Explorer, the
  Problems view, the reference numbering) gives a path to the innermost one.
- **Root list.** `consolidateRootPaths` (`config/root-paths.ts`) moves an open
  file that a workspace holds out of `openFiles`; a file beside a workspace stays.
- **A path that enters the application is its real path.** A root
  (`rootPathsOnDisk` at start, `addPath`, `root-open`), a document that opens
  (`DocumentManager.openFile`), a tab of the stored state (boot) and a
  document of the Agent API are named with each symbolic link resolved
  (`canonicalPath`, `app/util/real-path.ts`). The FSAL lists no symbolic
  link, so its paths are real too. A file that two names reach is one
  document with one sidecar: an annotation or a review made under one name
  is there under the other (#57). Code that takes a path from outside (a
  dialog, the command line, IPC from a window, an HTTP request) resolves it
  through one of these entries; it does not key a document by the path as
  given. Proof: `test/documents-move-identity.spec.ts`,
  `test/config-root-paths.spec.ts`.
- **Proof:** `test/renderer-path-polyfill.spec.ts` (Node's `path.relative` is the
  oracle), `test/config-root-paths.spec.ts`, `test/explorer-ordering.spec.ts`,
  `e2e/nested-roots.spec.ts`.
