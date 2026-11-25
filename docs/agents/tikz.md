# 7. TikZ figures and the external visual editor

Zettlr compiles a diagram and shows the figure. It holds no graphical diagram
editor. The graphical editor is the separate application Visual TikZ Editor
(`dzackgarza/visual-tikz-editor`, installed by its `just install-desktop`), and
Zettlr starts it on one diagram.

- **Render package:** `packages/tikz-render` (Bun workspace package
  `@dzack/tikz-render`) owns the TeX compiler (`src/tikz-render.ts`), the
  compiler log, the preview state and the preview pane
  (`src/ui/TikzPreviewPane.vue`). It must import nothing from `source/`. The
  application gives the pane a `TikzPreviewHost` (`src/host.ts`); Zettlr's host
  is in `MainEditor.vue` (the `tikz-render` IPC). See
  `packages/tikz-render/README.md`.
- **A render owns its processes and its scratch files.** The pandoc process
  of a render leads a process group; the shell and the TeX that the filter
  starts are in it. `renderTikz` stops the group at the time limit
  (`TikzRenderConfig.timeoutMs`, result `render-timeout`), when a signal ends
  pandoc, and when the app exits. It gives its result only when no process of
  the render is left, and it removes the temporary directory of the render
  (`TMPDIR` of the filter). The app sets the limit in
  `source/app/util/resolve-tikz-render-config.ts`.
- **One render at a time in the process.** Each `renderTikz` call waits for
  its turn (`renderTurns`, a semaphore of one): the preview of the editor
  (the `tikz-render` command, priority `preview`) and the compiles of the
  lint (`buildFlowmarkLintContext`, priority `background`). No two renders
  write one file of the cache at the same time, a figure that a second caller
  asks for while it compiles is a cache hit for that caller, and a preview
  goes before the lint renders that wait. A new caller gives its priority and
  holds no lock of its own. Proof: `test/tikz-compile-bound.spec.ts`.
- **Markdown detection stays in Zettlr:** `markdown-editor/tikz-block.ts` and
  `common/util/tikz-source-blocks.ts` turn Markdown into a `TikzSourceBlock`.
- **Controls:** `render-tikz.ts` places a rebuild button and an "Edit in Visual
  TikZ Editor" button over each figure; the preview pane has the same edit
  button. Rebuild bypasses the compiler cache. A click on the figure selects
  its authored source. The edit button is disabled for a diagram whose source
  is not one range of the document (a diagram in a blockquote or a list item).
- **Launch:** the window sends `tikz-edit-open` (`commands/tikz-edit.ts`) with
  a session id and the authored source. `TikzEditSessions`
  (`source/app/util/tikz-edit-session.ts`) writes the source to
  `diagram.tikz` or `diagram.tikzcd` in a temporary session directory and
  starts the command of the setting `tikz.visualEditorCommand`
  (`visual-tikz-editor`) with `--macros <central MathJax projection>
  --resources <document directory> <file>` as a detached process group. The
  session directory is also the `XDG_STATE_HOME` of that editor, so the
  recovery record of the editor stays apart from the user's own. The file
  extension decides the editor: `.tikzcd` opens in Quiver. A missing command
  is an error dialog, not a fallback.
- **Saves:** the main process watches the session file and sends each new
  content on the `tikz-edit` channel. `tikzEditSessionsField`
  (`markdown-editor/tikz-edit-sessions.ts`) follows the range of each open
  diagram through the edits of the author and keeps the source that the
  document and the editor last agreed on. A save replaces the range only while
  the range still holds that source. A save after the author changed the
  diagram in the document is refused with a message: the document is the
  authority. The document sends nothing to a running editor.
- **`\input` diagrams:** a block that is `\input{file.tikz}` opens that file
  itself. The editor saves to the file; there is no session and no document
  change.
- **End of a session:** the editor stops when its view state goes away (a
  closed tab, a document loaded again: `tikz-edit-close`) and when the app
  quits (`CommandProvider.shutdown` calls the `shutdown` of each command and
  waits until each editor is gone). The stop has a time limit: the process
  group of the editor gets SIGTERM, and an editor that still runs two seconds
  later gets SIGKILL. The session directory is removed when the editor exits.
- **Proof:** `test/tikz-edit-sessions.spec.ts` (the range and refusal rules),
  `test/tikz-edit-process.spec.ts` (the time limit of a stop),
  `e2e/tikz-live-preview.spec.ts` (the pane), and
  `e2e/desktop/tikz-external-editor.spec.ts` (the assembled app with the
  installed editor; a workstation proof, not a hosted CI job).
- **Install layout:** `bunfig.toml` pins Bun's hoisted linker. The workspace would
  otherwise select the isolated linker, and webpack/Forge resolve transitive
  dependencies from the hoisted `node_modules`.
