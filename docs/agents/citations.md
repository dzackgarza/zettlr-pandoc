# 12. Citations and attachment files

- **One owner gives the bibliography of a document.** `documentBibliography`
  (`source/app/util/document-bibliographies.ts`) reads the front matter of
  the text of the document (the buffer of an open document) and the Project
  of its folder. The files of the front matter are the bibliography; else
  the bibliographies of its Quarto book and the main library; else the main
  library. A relative entry resolves from the folder of the document. A
  window asks the command `get-document-bibliography` through
  `documentCitationDatabase` (`common/util/document-citation-database.ts`);
  the command waits until the libraries are loaded. The editor, the print
  window, the outline, the hover previews, the Annotations view, the
  References view, the attachment command, the lint, the documents provider
  and the PDF export ([§3](export.md)) use it. A new view that renders citations of a
  document asks it; it does not read the front matter or the Project
  itself (#198). Proof: `e2e/document-bibliography.spec.ts`,
  `test/export-bibliography.spec.ts`.
- **Locales.** `CiteprocProvider` reads its CSL locales from the one directory
  that its owner gives: `BUNDLED_LOCALE_DIRECTORY` in the app, `static/csl-locales`
  in a spec. The working directory decides nothing. The `en-US` locale is
  required: the engine load stops with the read error when the file is absent or
  unreadable. For another language an absent file is the answer `false` of the
  citeproc-js `retrieveLocale` protocol; each other failure is an error.
- **Attachments come from the library text.** `extractBibtexAttachments`
  (`citeproc/util/extract-bibtex-attachments.ts`) reads the `file` field of each
  entry as Zotero's BibTeX translator writes it: records apart by an unescaped
  `;`, parts apart by an unescaped `:`. A change to what the loader keeps must
  move the parse cache version.
- **Only files on disk.** `getBibTexAttachments` gives the files that the library
  names for a citation key and that exist. The open-attachment command opens the
  first one. When the library names files and none exists, the command logs
  that and asks Zotero (the Better BibTeX JSON-RPC).
- **A library is parsed on a thread of its own.** The parse of a BibLaTeX
  library of some thousand entries takes seconds and gives the event loop no
  turn (#138). `loadDatabaseOnThread` (`citeproc/util/load-database-on-thread.ts`)
  starts one Node worker thread for one read; the thread program is
  `database-loader-worker.ts`, a second entry of `webpack.main.config.js`
  (`.webpack/main/database-loader-worker.cjs`, `BUNDLED_DATABASE_LOADER_THREAD`).
  The thread program and what it imports must import nothing of Electron. A
  spec gives the provider the TypeScript program (`test/citeproc-loader-thread.ts`).
- **The record of a library comes to the main thread one entry at a time.**
  A record that goes through `postMessage` as one object is made again on
  the main thread in one step, whose time follows the size of the library.
  The thread serializes each entry on its own into one buffer and transfers
  the buffer; the main thread reads one entry in each turn of its event loop
  (`citeproc/util/database-record-transfer.ts`). A new value that a thread
  sends to the main process and whose size follows a library or a workspace
  goes the same way.
- **Nothing waits for a library.** The start of the app and the open, close
  and save of a document name the libraries and do not wait for the reads
  (`startDatabaseSynchronization`). A window draws its citations again when a
  library arrives (`citeproc-database-updated`). The synchronous citation
  call of an editor answers without a citation while the library of the
  request is in its first read, and starts the read of a library that the
  provider does not know. A caller that needs the items waits:
  `synchronizeDatabases` for the libraries it names, `loadsEnded()` for each
  running read (the Agent API citation and Zotero routes, a spec after
  `boot()`).
- **A changed library keeps its items until the new read ends.** The watcher
  starts a read and stops the read that runs for that file; a stopped read
  ends its thread. A read that fails drops the items of the file and keeps
  the watch, so a file that appears or changes is read again.
- **A bibliography that does not load is a problem too.** A file that the
  front matter of a document or the manifest of a Quarto book names and that
  cannot be read is a `CitationResourceProblem` with the resource
  `bibliography`. No setting names it: its message has no "Open Preferences"
  action. It does not reject the open, close or save of the document.
- **A style or a library that does not load is a problem, not a stop.**
  The app starts when `export.cslStyle` or `export.cslLibrary` names a file
  that cannot be read or parsed. `CiteprocProvider` keeps each such file as a
  `CitationResourceProblem` (resource, path, cause), answers the list on the
  IPC command `get-problems`, and broadcasts each change of the list on
  `citeproc-problems`. A window follows the list through
  `followCitationProblems` (`common/util/citation-problems.ts`): the main
  window shows a message with the action "Open Preferences", the Preferences
  window marks the file field (`FileField.problem`), and the References view
  shows the sentence in place of a bibliography.
- **No citation in another style.** While the style of the setting is not
  loaded, a render of a citation or of a bibliography throws
  `CitationStyleError`; the bundled style and the style of the last setting
  are not used. The Agent API answers 503 `CITATION_STYLE_NOT_LOADED`. The
  cite keys of the libraries stay available. Each load of a style broadcasts
  `citeproc-database-updated`, so the windows draw their citations again.
- **A preview that cannot render shows its source and the cause.** A
  preview of Markdown through `md2html` (a cross-reference, a footnote, a
  wikilink, an outline entry, an annotation, the excerpt of a new
  annotation) that rejects shows `unrenderedPreviewHtml`
  (`common/util/unrendered-preview.ts`): the source text and the cause. A
  new preview does the same; it does not only log the rejection. Copy as
  HTML shows the cause in a message. Proof:
  `e2e/preview-citation-failure.spec.ts`.
- **The Agent API names a library that did not load.** A citation route
  whose database the provider does not have answers 503
  `CITATION_DATABASE_NOT_LOADED` with `error.database`, the file and the
  cause; without it, the settings name no main library. The API reads no
  file that a caller names: a path that is not a library of the settings, of
  an open document or of a Project is not loaded. The listing
  (`target=databases`) gives the libraries that did not load in
  `notLoaded`. A render answers 404 `CITATION_NOT_FOUND` with
  `error.missingCitekeys` for each cite key that the database does not
  hold; a bibliography does not leave a key out.
- **Proof:** `test/citeproc-unreadable-style.spec.ts`, `test/agent-http-api.spec.ts`
  ("citation libraries that did not load"),
  `e2e/unreadable-citation-style.spec.ts`,
  `test/citeproc-library-parse-thread.spec.ts` (the event loop during a
  parse, the calls that do not wait), and `e2e/citation-library-thread.spec.ts`
  (the thread program in the packaged app; run `just package` before it).
