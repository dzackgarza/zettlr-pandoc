<!-- agent-memory:start -->
# Agent memory

This repository uses the central agent memory vault at `/home/dzack/.agent-memory-vault`.

Project memory key: `projects/github.com__dzackgarza__zettlr-pandoc/index`.

Repository `.agents` and `.hermes` paths are symlinks to the same vault-owned project directory.

Before changing architecture, search both project and global memory:

```bash
agent-memory search --scope both "<task or subsystem>"
```

## Read the plan before starting work

This project's plans live in the vault as cards, not in the repository. Before writing
code, proposing a design, or reporting on the state of a feature, list the plans and read
the one that covers the task:

```bash
agent-memory list --type plan --scope project
agent-memory plan show <PLAN-ID>
agent-memory plan progress --scope project
```

A plan card carries phase children with their own gates and acceptance criteria. Read
those too before starting a phase:

```bash
agent-memory phase show <PHASE-ID>
```

`agent-memory retrieve` reads memory notes and takes a vault-relative key, not a card id.
Use `plan show`, `phase show`, or `card show` for cards; they take the id.

The vault card is authoritative. Repository files that restate a plan — `.pr/PR_BODY.md`,
design transcripts, mockup directories — are derived copies that go stale. Read the card,
and when the two disagree, the card wins.

Record durable repo-specific lessons with:

```bash
agent-memory add --scope project --type decision --title <title> --content <content>
agent-memory add --scope project --type trap --title <title> --content <content>
agent-memory add --scope project --type advice --title <title> --content <content>
agent-memory add --scope project --type context --title <title> --content <content>
agent-memory add --scope project --type reference --title <title> --content <content>
```

Plan work is card-backed. Create and update plan cards with `agent-memory plan add` and `agent-memory plan update`, not `agent-memory add --type plan`.

Use `agent-memory retrieve <key>`, `agent-memory update <key>`, and `agent-memory delete <key>` for memory CRUD.

The vault should be committed at all times. Treat staged or unstaged vault changes as an ephemeral error state. Before normal memory work resumes, load the bundled vault-maintenance skill with `agent-memory maintain skill vault-maintenance` and follow its referenced check, repair, and commit workflows.

Move reusable lessons during maintenance with:

```bash
agent-memory maintain move <key> --to global/advice
```
<!-- agent-memory:end -->

# zettlr-pandoc — system-specific wiring (read this before debugging)

This is a fork of upstream **Zettlr**. Almost everything here is stock Zettlr; this
document covers only the **delta** — the integrations wired specifically into this
system, where they live, and how to follow them when something breaks. When a
subsystem is not mentioned here, it is upstream Zettlr and its own docs apply.

The app is rebranded to **Zettlr-Pandoc** (`package.json` `productName`), so it has
its **own** config dir, separate from any stock Zettlr install:

- `~/.config/Zettlr-Pandoc/` — `config.json`, `defaults/` (export profiles),
  `logs/`. Macro semantics do **not** live in this profile.

## Task runner: `just`

All project workflows route through the top-level `justfile`. **`just --list`** is
the source of truth for recipes; do not run builds/exports/tests by hand when a
recipe exists. Key recipes (see the `justfile` for the exact commands):

| Recipe                                  | What it does                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `just launch`                           | Dev mode through `scripts/test-gui/index.mjs`; uses the isolated `resources/test-cfg` profile.                 |
| `just launch-desktop`                   | Dev mode (`electron-forge start`) with the normal user configuration. **This is the desktop path that works.** |
| `just install-desktop-launcher`         | Install the repo-owned Hyprland launcher and desktop entry under `~/.local`.                                   |
| `just package`                          | Production build and freshness verification (`electron-forge package`) → `app.asar`.                           |
| `just verify-build`                     | Build, then prove the asar is fresh + built from HEAD (observability).                                         |
| `just verify-build-only`                | Fast staleness check of the existing artifact (no rebuild).                                                    |
| `just export-headless PDF.yaml file.md` | Run the real `makeExport` headlessly (no GUI) — debug exports.                                                 |

## Build process

- **Dev mode** — `electron-forge start` (`just launch-desktop`). Webpack dev
  build from source on every start; reflects the working tree. **Works.** The
  desktop launcher uses this. `just launch` instead routes through the
  repository's isolated GUI-test profile.
- **Production** — `electron-forge package` (`just package`) → `out/Zettlr-Pandoc-linux-x64/resources/app.asar`.
  webpack configs: `webpack.main.config.js` (Node/main target), `webpack.renderer.config.js`
  (browser/renderer), assembled by `forge.config.js`. The wrapper fails if the build
  does not create a fresh `app.asar` from the current source fingerprint.
- **Build observability** — `scripts/verify-build.py` (`just verify-build`). Proves the
  asar was built from the current commit via the `__GIT_COMMIT_HASH__` string that
  `DefinePlugin` bakes into the bundle (`webpack.{main,renderer}.config.js`, sourced
  from `scripts/get-git-hash.js`, referenced by `source/win-about/Debug-Tab.vue`).
  Run `just verify-build-only` to instantly answer "is my installed app actually
  current?".

## The global-app launcher

Desktop entry → wrapper → splash → boot script:

- **Source of truth:** `scripts/desktop/`, installed by
  `scripts/install-desktop-launcher.sh` (`just install-desktop-launcher`).
- `~/.local/share/applications/zettlr-pandoc.desktop` is rendered from the
  repo-owned template (`StartupWMClass=zettlr-pandoc`).
- `~/.local/bin/zettlr-pandoc-dev` and `zettlr-pandoc-boot` are symlinks to the
  repo-owned scripts. The wrapper opens the floating kitty boot splash
  (Hyprland float/center via `hyprctl dispatch`).
- `zettlr-pandoc-boot` is the actual launcher. It refreshes MathJax macros, then
  starts the verified packaged build through `just package` when the source
  fingerprint is stale. It retains focus-if-running (intentional — do not
  "fix"), Hyprland window-class detection (`class == zettlr-pandoc`), and
  fail-loud behavior on build or launch failure.
- Launcher log: `~/.cache/zettlr-pandoc-dev.log`.

## Shared Markdown editor

`packages/pandoc-editor` owns the reusable CodeMirror presentation and Pandoc parser.
Both Zettlr and math-flashcards consume its `markdownEditor` factory. The package
imports no application modules. Hosts supply math conversion, preview configuration,
and ranges that must remain source text. Zettlr adds document-specific renderers
through its renderer collection. See `packages/pandoc-editor/README.md`.

## System-specific integrations

### 1. Central mathematical macro system

- **Only semantic source of truth:** `~/.pandoc/styles/macros/` (the user's ~1600-macro
  authoring language). Zettlr is a consumer. It must never seed, edit, bundle, prefer,
  or fall back to an app-local macro definition file.
- **Generated MathJax projection:** `~/.pandoc/templates/css/mathjax-macros.json`,
  generated by `~/.pandoc/bin/generate-mathjax-config.py` / `just generate-math-macros`.
  `zettlr-pandoc-boot` regenerates the central projections before launch.
- **App load:** `source/app/util/load-mathjax-macros.ts` resolves that central generated
  file and fails loudly when it is absent. The `mathjax-macros` IPC in
  `source/app/lifecycle.ts` serves the same read-only projection to renderer consumers.
- **Format/validation:** `packages/tikz-render/src/mathjax-config.ts` (`parseMathJaxMacros`;
  malformed central projections fail rather than being replaced with bundled defaults).
- **Render:** `source/common/util/mathtex-to-html.ts` (`initializeMathJax`, local
  CommonHTML), wired in `source/common/modules/window-register/index.ts`.
- **TikZ:** TeX compilation follows the real central `dzg-tikz` template/include
  graph.
- **Semantic invariant:** macro meanings and arities are owned by `~/.pandoc`; Zettlr
  may project or adapt them to a renderer but must not redefine their mathematics. See
  `~/.pandoc/AGENTS.md` for the object-valued/atomic macro rule.

### 2. LaTeX math delimiters `\[ \]` and `\( \)`

Upstream Zettlr only recognizes `$`/`$$`. This fork adds the LaTeX delimiters, and
they must be threaded through **four** layers:

- **Parser:** `packages/pandoc-editor/src/parser/math-parser.ts` —
  `blockMathParser` (opens on `\[`, closes on `\]` incl. a trailing `.\]`),
  `inlineBracketMathParser` (handles `\( \)` **and** `\[ \]` mid-paragraph, spanning
  newlines; runs `before: 'Escape'` or the backslash opener is eaten as an escape).
- **Registered:** `packages/pandoc-editor/src/parser/markdown-parser.ts`.
- **Shared pure helpers:** `packages/pandoc-editor/src/util/math-delimiters.ts`
  (`MATH_DELIMITERS`, `mathDisplayForOpen`, `stripMathDelimiters`). **This module must
  import nothing (no CodeMirror/lezer)** — `markdown-to-html` runs in the main
  process, and dragging the editor graph into that Node bundle breaks the webpack
  build.
- **AST:** `source/common/modules/markdown-utils/markdown-ast/index.ts` (treats `\[`
  and `\(` code marks as math).
- **HTML (`md2html`):** `source/common/modules/markdown-utils/markdown-to-html.ts`.
- **Live editor widget:** `packages/pandoc-editor/src/renderers/render-math.ts`.

### 3. PDF export → the `~/.pandoc` `compile-pandoc` recipe

- **`~/.pandoc` is a plain directory whose `justfile` and `filters/*` are symlinks
  into a checkout of `dzackgarza/pandoc-config`** (currently the vendor submodule at
  `~/pandoc-preview-greenfield2/src-tauri/resources/vendor/pandoc-config`; a
  development clone lives at `~/gitclones/pandoc-config`). That `justfile` is the
  **authoritative contract** for PDF conventions (filters, flags, engine). Read it
  before reverse-engineering export behavior.
- **PDF export delegates** to that recipe — the app owns no pandoc/LaTeX flags:
  `source/app/service-providers/commands/exporter/recipe-exporter.ts` runs
  `just --justfile ~/.pandoc/justfile compile-pandoc <file> <title> [<template>]`
  for single files, and `compile-pandoc-project <title> <template> <files…>` for
  ordered Project exports (issue #1).
  PDF is a **custom profile** (`writer: compile-pandoc`) in `getCustomProfiles`
  (`exporter/index.ts`); dispatch is in `makeExport`. The dzg templates require
  **pdflatex** (xelatex/lualatex fail).
- The Chromium "Simple PDF" export was removed; every export now goes through pandoc.
- Export profile list: `list-export-profiles` in
  `source/app/service-providers/assets/index.ts` = `listDefaults()` (userData/defaults)
  - `getCustomProfiles()`, with custom profiles overriding same-named defaults.

### 4. Quarto books

A directory is a Quarto project when a manifest describes it. Quarto stays the
manifest, render and numbering authority; Zettlr reads the authoring fields.

- **Where the manifest is.** `<dir>/_quarto.yml`, or the file the directory is bound
  to. The binding is `DirectorySettings.quartoManifest`, a path relative to the
  directory, set from the directory properties popover and persisted in
  `.ztr-directory`. It exists because a book may keep its manifest in an assembly
  directory beside the machinery that renders it — `~/research/writing/.book/` — with
  the prose one level up.
- **The project is derived, never stored.** `parseQuartoManifest`
  (`fsal-directory.ts`) rebuilds it from the manifest on every load, and
  `persistSettings` writes only the settings the user authored. `.ztr-directory` may
  name where the manifest is; it must never carry a copy of the order, the chapters or
  the bibliographies, which the manifest owns (#83). A project the user made
  themselves (`manifest.kind === 'zettlr'`) is authored, and is left alone.
- **A chapter's identity is its real path.** `parseQuartoProject`
  (`source/app/util/quarto-project.ts`) resolves each path against the manifest's own
  directory and then through `realpath`, so a symlinked chapter is the file it points
  at and no file reaches the document model under two names. `parseQuartoManifest`
  then names each chapter relative to the real path of the Project directory, so
  `ProjectSettings.files` holds directory-relative paths with `/` separators for a
  Quarto project and for a Zettlr one.
- **A part is a title or a file.** Quarto reads the `part` of a book as a file when
  a file is at that path beside the manifest, and as a title otherwise.
  `quartoPartFile` (`quarto-project.ts`) makes the same decision. A part that a file
  names is a `part-file` navigation item: the file is a document of the book, before
  the chapters of its part in `ProjectSettings.files`, and its title is the title of
  the part. The Book module shows it as a numbered row that opens the file.
- **The Project of a file is the innermost Project directory that holds it.** A
  Project directory is a loaded directory with `settings.project`, at any depth of
  a workspace; the workspace store lists them (`projectDirectories`), and
  `projectRootForPath` (`common/util/explorer-ordering.ts`) decides. A book in a
  subdirectory of a book owns its own chapters.
- **Consumers:** the Book module (`QuartoBookOutline.vue`; `NavigationSidebar.vue`
  shows it when the Project of the active file is a Quarto book), the Explorer
  membership marks, inherited bibliographies
  (`get-bibliography-for-descriptor.ts`), and project export.

### 5. Startup preflight

- `source/app/util/preflight.ts`, called from `source/app/util/environment-check.ts`.
  Fails loud (native dialog + `app.exit(1)`) if `pandoc`, `just`, `latexmk`,
  `pdflatex`, `biber`, or `~/.pandoc/justfile` are missing in the app's runtime
  environment.
- **The app uses the `PATH` it was started with.** The launcher owns the
  environment; a wrong `PATH` is a preflight failure, not something the app
  repairs. Upstream Zettlr runs the user's login shell at startup (`fix-path`)
  to read another `PATH`; this fork removed that. On this machine that shell
  is the one that starts a second compositor when `WAYLAND_DISPLAY` is unset.
- The command checks and the three gates of the preflight run at the same time.
  The preflight costs the time of the slowest tool, not the sum.

### 6. Agent API MCP tunnel

- The agent API listens on `127.0.0.1:27412` only and has no authentication. It
  serves the OpenAPI routes and, at `/mcp`, the same operations as an MCP server
  (`source/app/service-providers/agent-api/mcp-endpoint.ts`).
- Operations tagged `zotero` in `openapi.yaml` are served at `/zotero/mcp` (MCP
  server `zettlr-pandoc-zotero`), not at `/mcp`, and the served `/openapi.json`
  leaves out their routes; the Custom GPT Action imports that document and has
  a limit of 30 operations. `ZoteroLibrary` (`agent-api/zotero-library.ts`)
  searches through the Zotero local API (`127.0.0.1:23119/api`) and imports
  through the `/write` route of the zotero-local-write-api add-on. Zotero
  identifies the source and fetches the metadata and the PDF; the caller sends
  no BibTeX. A source that Zotero cannot identify answers 422
  `ZOTERO_SOURCE_NOT_IDENTIFIED` with the add-on's remediation (known-good
  sources). A repeat with `fallbackMetadata` (title, creators, year) saves the
  item tagged `metadata:unresolved`. An import returns the Better BibTeX key and
  waits until the main citation library (the Better BibTeX auto-export) has it
  (`citable`). `just test-zotero-integration` proves this against the running
  Zotero.
- ChatGPT reaches `/mcp` only through the OpenAI Secure MCP Tunnel
  `tunnel_6aba3fe9f56081919348c7060b52188f`. The user unit
  `scripts/systemd/openai-tunnel-zettlr-pandoc.service` runs
  [`tunnel-client`](https://github.com/openai/tunnel-client) from
  `~/.local/bin`. It long-polls `api.openai.com` with `CONTROL_PLANE_API_KEY` from
  `~/.envrc`, so it needs no inbound port and no public hostname. The unit sets
  `GODEBUG=http2client=0`: over HTTP/2 the client keeps one dead connection
  after a suspend and misses every request for about 16 minutes. The system
  unit `openai-tunnel-zettlr-pandoc-resume@.service` also restarts the tunnel
  at each resume (`just install-systemd-tunnel-resume`).
- Recipes: `just install-systemd-tunnel`, `just start-systemd-tunnel`,
  `just status-systemd-tunnel`. The tunnel-client health and web UI listener is
  `http://127.0.0.1:27414/ui`; `/readyz` reports readiness.
- In ChatGPT, the app uses Connection: Tunnel with that tunnel ID. Tool calls fail
  while the editor is closed; the tunnel itself stays up.
- ChatGPT keeps the tool list it read when the app was created or last
  refreshed. A contract change (a new operation, a new request body) reaches
  ChatGPT only after Refresh on the app's settings page and a new
  conversation. Until then the model calls the old tool shapes.
- `agentApi.skillsDirectory` in `config.json` is a read-only filesystem
  capability exposed through the existing `getHelp` MCP tool: use
  `resource=skills`, with `action=list` or `action=read` plus a relative `.md`
  `path`. Symlinks, traversal, and non-Markdown files are not exposed. The
  ChatGPT connector has a hard 30-tool limit; `/mcp` itself must therefore stay
  at 30 tools rather than hiding extra operations only from `/openapi.json`.

### 7. TikZ figures and the external visual editor

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
  starts `visual-tikz-editor --macros <central MathJax projection>
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
  waits until each editor is gone). The session directory is removed when the
  editor exits.
- **Proof:** `test/tikz-edit-sessions.spec.ts` (the range and refusal rules),
  `e2e/tikz-live-preview.spec.ts` (the pane), and
  `e2e/desktop/tikz-external-editor.spec.ts` (the assembled app with the
  installed editor; a workstation proof, not a hosted CI job).
- **Install layout:** `bunfig.toml` pins Bun's hoisted linker. The workspace would
  otherwise select the isolated linker, and webpack/Forge resolve transitive
  dependencies from the hoisted `node_modules`.

### 8. Workspace wikilinks

- **Resolution:** `source/common/util/wikilink-resolution.ts` (`WikilinkIndex`).
  A `[[target#heading|label]]` target is a relative path (`./`, `../`, absolute:
  resolved against the source file) or a name. A name matches, case-insensitively
  and in this tier order, the Zettelkasten `id`, the path relative to the file's
  workspace root, a suffix of that path, a YAML `aliases` entry, the YAML `title`. The first tier
  with a match decides; two matches in it are ambiguous, never a first match.
  The written form (`canonical`) is the shortest suffix that names the file alone.
- **Owner:** `LinkProvider` (`service-providers/links`) rebuilds the index once
  for each batch of FSAL events that holds a Markdown file or a removal, and
  broadcasts `links` only when the links or the index entries changed. The root
  of a file is the innermost open workspace that contains it.
  Every consumer resolves through it: force-open (with `#heading` → `jump-to-line`),
  hover preview, backlinks, graph, autocomplete (`get-link-targets`), and
  file rename, move and directory rename (`LinkProvider.filesChangedByMove` and
  `retargetAfterMove` rewrite only the links whose document the move changed).
  `[[#heading]]` (empty target) resolves to the linking document; backlinks and
  the graph leave that self link out.
- **Editor chips:** the renderer bundle has no `path`, so the editor cannot run
  `WikilinkIndex`. `MainEditor.vue` sends the document's targets to the IPC
  command `resolve-wikilinks` and stores the answer in
  `wikilinkResolutionsField` (`markdown-editor/plugins/`). `render-wikilinks.ts`
  draws a link that resolves to one document as a chip; an ambiguous or missing
  link stays raw text, and Flowmark reports it. Mod-click on a chip opens it.
- **Lint:** Zettlr sends `wikilinks.resolutions` in the Flowmark context
  (`flowmark-lint-context.ts`); the rules `link/missing-wikilink-target`,
  `link/ambiguous-wikilink` and `link/relative-wikilink` live in pandoc-flowmark.
  The lint cache key includes those resolutions, so a rename elsewhere refreshes
  the diagnostics of the documents it affects.
- **YAML `aliases`** is parsed by `fsal/util/file-parser.ts`. A change to what the
  parser extracts must bump `PARSER_VERSION` in `fsal-file.ts`; cached descriptors
  of another version are parsed again.
- **PDF export:** `recipe-exporter.ts` writes `wikilinkExportMap`
  (`common/util/wikilink-export.ts`): the heading count of each input and, per
  raw target, the input and heading it resolves to. `PANDOC_WIKILINKS` names
  that file for the recipe, whose `filters/wikilinks.lua` in pandoc-config
  turns each resolved link into a link to that heading and any other link into
  its label. The filter resolves nothing itself.
- **Renderer imports:** `wikilink-resolution.ts` imports Node `path`, which
  the renderer bundle maps to an empty module. Editor and window code import
  `splitWikilinkTarget` from `common/util/wikilink-target.ts`, which imports
  nothing, and ask the main process for resolutions.

### 9. Responsiveness contracts

The cost of a typed character, a caret move and a filesystem event must not
follow the length of the document or the size of the workspace (#132). These
rules keep that property. The measurement harness and the safe launch command
of an isolated instance are in the first comment of #132.

- **Decorations from syntax nodes** go through `incrementalNodeDecorations`
  (`markdown-editor/util/incremental-node-decorations.ts`). A transaction
  computes again only the top-level blocks that the parser made again and the
  ranges that the selection left or entered. `renderBlockWidgets`
  (`renderers/base-renderer.ts`) is built on it. A renderer that reads a state
  value other than the document, the syntax tree and the selection reports a
  change of that value through `inputsChanged`; a value that it does not
  report leaves stale widgets.
- **A widget holds no document position.** The field keeps a widget outside a
  changed block, so a stored position goes stale. A handler reads the position
  from `view.posAtDOM`. The `eq` of a widget compares what the widget shows.
  The widget decorations of `base-renderer.ts` have `Prec.high`, so a widget
  owns the whole source of its node and `view.posAtDOM` gives the start of
  that source. A replacement of lower precedence that starts at the same
  position (the hidden `$` code mark of an equation) is not drawn.
- **An equal value causes no transaction.** `setWorkspaceReferences`,
  `setWikilinkResolutions`, `setCompletionDatabase`, the collaboration session
  store and `modeSwitcher` (`renderers/index.ts`) dispatch or reconfigure only
  for a changed value. A `Compartment.reconfigure` makes the view draw its
  content again. `configField` keeps its object for a configuration update
  with equal values, so a renderer can compare the field by identity in
  `inputsChanged`.
- **An editor in a background tab receives no workspace transaction.** It
  reads the workspace state, the citation data and the completion databases
  when its tab becomes active (`refreshActiveEditorAuxiliaryState` in
  `MainEditor.vue`).
- **Citations are drawn again when the citation database changed.**
  `render-citations.ts` counts those changes (`citationDatabaseChanged`); a
  citation widget carries the count it was drawn at, and `syncCitationData`
  draws the citations of an editor again when the count moved. The identity of
  the `metadata` configuration object is not a signal: it changes with each
  configuration update.
- **No `ipcRenderer.sendSync` in the path of a transaction.**
- **FSAL events are batches.** FSAL publishes `fsal-events`: the events of
  50 ms in one array, to the main-process listeners and to the windows. A
  consumer does its work once for each batch and broadcasts only a changed
  value.
- **One parse of one document version in the main process.** `markdownToAST`
  (`markdown-utils/index.ts`) keeps the ASTs of the texts it parsed last. The
  AST is shared: a reader must not change it. Editor code passes the tree that
  the editor has (`markdownToAST(text, tree)`), as the spellcheck context does.
- **Pandoc reads one citation candidate once.**
  `references/pandoc-citations.ts` keeps the reading of each candidate source;
  an edit that changes no citation starts no Pandoc process.
- **One probe of an external tool in a session** (`tikz-render.ts`,
  `flowmarkToolPython`).
- **One load of a citation database.** `CiteprocProvider` shares the load that
  runs for a database path between concurrent requests.
- **`@codemirror/collab` is patched**
  (`patches/@codemirror%2Fcollab@6.1.1.patch`): a local update holds no
  transaction. Without the patch the `origin` of each unconfirmed update keeps
  one transaction and two editor states alive for each typed character. A
  version update of the package must keep the patch until the package has the
  change.

### 10. File filters

- **What the filter judges:** the gitignore rules and the file types. A
  file type is hidden when it is not in `fileManager.filters.include`
  (empty: every type), when the `files.<type>.showInFilemanager` of its
  group is off, or when it is of no known type and its extension is not in
  `attachmentExtensions`. Markdown and code files are always of a known
  type. A path with a segment that starts with `.` is a dot path, hidden
  while dot files are off; a folder is hidden by type only as a dot path.
  `IgnoreFilter.matches` judges both, `ruleMatches` the rules only (Hide
  and Unhide edit rules, so they read `ruleMatches`).
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
  provider has its own watcher and does not read `fsal-events`.
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

### 11. Path containment

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
- **Proof:** `test/renderer-path-polyfill.spec.ts` (Node's `path.relative` is the
  oracle), `test/config-root-paths.spec.ts`, `test/explorer-ordering.spec.ts`,
  `e2e/nested-roots.spec.ts`.

### 12. Citations and attachment files

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

### 13. Assembled-app E2E runs

- `just test-e2e` and `just test-e2e-file <spec>` run the specs of `e2e/`. A spec
  that starts the app through `attach` (`e2e/support/electron-app.ts`) runs
  `electron-forge start`: a development build of the working tree for each start.
  `e2e/application-lifecycle.spec.ts` starts the packaged binary.
  `currentPackagedBinary` refuses a build whose source fingerprint is not that of
  the tree: run `just package` before that spec.
- **The run owns the display.** With `DISPLAY` unset the recipe starts the whole
  Mocha process under one `xvfb-run`; a spec starts no X server of its own.
- A Chromium probe of test-support code reports its exit code or signal, its
  output and the X server errors when it fails (`test/visual/display-probe.ts`).
- An e2e run and a `just package` build each need most of the memory of this
  workstation. Run one at a time.

### 14. Document identity and refused closes

- **The id of a document moves with its path.** `DocumentManager`
  (`service-providers/documents/index.ts`) keeps the path of each id and the
  id of each path. A rename or a move goes through `hasMovedFile` or
  `hasMovedDir`, which move the id, the loaded document, its tabs and its
  collaboration state under the document lock (`_movePathOfDocument`, then
  `renameCollaboration`). A new transition that changes the path of a
  document goes through them; it must not assign a new id to the new path.
- **The sidecar follows the file.** The sidecar of a closed document moves
  with the file too: `hasMovedDir` reads `listCollaborationSidecars()` for the
  documents that are not loaded. A document whose file a move replaced is
  dropped with its tabs, its state in memory and its sidecar
  (`_dropReplacedDocument`).
- **Collaboration state in memory belongs to a loaded document.** A document
  that a refused proposal loaded and released has no state in memory.
- **No close is refused without an action.** A close of a tab, a window
  close and a quit detach the collaboration state through `_detachForClose`.
  When the sidecar cannot be written, it records how to repeat that close
  and broadcasts `save-refused` with `closeRefusedFor`. The window shows the
  cause with the action "Close anyway" (`App.vue`), which
  sends `close-without-review`. `closeWithoutReview` drops the state in
  memory, leaves the sidecar as it was last written, and repeats the close.
  A new path that closes a document detaches through `_detachForClose`.
- **The answer "discard" at a close prompt goes through `_discardForClose`.**
  A discard that fails (the sidecar cannot be written, the file cannot be
  read) is a refused close with the same action. `closeWithoutReview` then
  closes the tabs of the document and unloads it: its buffer is the text
  that the author threw away.
- **`closeWindow` answers whether the window may close.** The window
  provider closes the `BrowserWindow` only for `true`, and gives the
  documents provider the function that repeats the close.
- **Proof:** `test/documents-move-identity.spec.ts`,
  `test/documents-refused-close.spec.ts`,
  `e2e/rename-annotated-document.spec.ts`,
  `e2e/review-persistence-failure.spec.ts`.

### 15. Failed application commands

- **A command that cannot do its work throws.** A command
  (`service-providers/commands/`) throws an `Error` whose message names the
  file or folder and the cause. It does not write the cause to the log and
  answer `false`: `false` is a value of the contract of some commands, and a
  caller cannot tell it from a failure.
- **The dispatcher shows each failure once.** `CommandProvider.run`
  (`commands/index.ts`) logs the error, broadcasts it on `command-failed`
  (`types/common/command-failure.ts`) and rejects to the caller. The main
  window shows the message as an error (`App.vue`). A command that runs a
  command (`force-open`, `tutorial-open`) passes the same error on; the
  dispatcher shows it one time.
- **A caller does not show a rejection of a command.** It logs the rejection
  (`reportError`) and stops its own work: no success message, no further
  step. A second message in the caller repeats the first.
- **`CALLER_SHOWS_FAILURE`** names the commands that a window runs on its
  own (a lint pass, a figure render, a hover preview). Their callers show the
  failure in their own place, and the dispatcher broadcasts nothing for them.
  A new command of that kind goes into the set; a command that an action of
  the author starts does not.
- **A command that prompts answers its contract.** A command that showed the
  cause itself in a native dialog (`dir-rename`, the project export of one
  profile) returns its value and does not throw as well.
- **Proof:** `e2e/command-refusal.spec.ts`.

## Debugging entry points

- **Export not working?** `just export-headless PDF.yaml <file>.md` runs the literal
  `makeExport` headlessly (`scripts/harness/`, electron stubbed at `require`), building
  the same profile list the GUI sees — reproduces export bugs without the app.
- **"App isn't showing my change"?** Run `just verify-build-only`. If the asar is
  stale, the desktop launcher runs `just package` before it starts the binary.
  Use `just launch-desktop` for a direct development run.
- **Editor math not rendering?** `test/editor-latex-delimiters.spec.ts` and
  `test/editor-math-widget.spec.ts` drive the parser and a real `EditorView`
  headlessly. Check the canonical source under `~/.pandoc/styles/macros/` and the
  generated `~/.pandoc/templates/css/mathjax-macros.json`; the desktop launcher
  regenerates that central projection before launch.
- **Logs:** launcher `~/.cache/zettlr-pandoc-dev.log`; app `~/.config/Zettlr-Pandoc/logs/`.
- **In-editor Markdown linter** is the standalone Flowmark linter
  (`flowmark-lint`). Flowmark is a system tool like pandoc, not a vendored copy:
  at every start the app runs `uv tool install --upgrade` for the main branch of
  `dzackgarza/pandoc-flowmark` in the background
  (`source/app/util/flowmark-update.ts`). A failed update (no network, a broken
  main) keeps the installed Flowmark and stays in the task list as a failed task; it never
  stops the app. `just install-flowmark` installs the same source for CI and
  tests. The LanguageTool plugin runs under that tool's Python
  (`flowmarkToolPython`). The editor has no rule/linter layer of
  its own: external providers implement the editor-neutral contract in
  `source/common/diagnostics/external-linter.ts`, and exactly one
  CodeMirror bridge exists at
  `source/common/modules/markdown-editor/diagnostics/external-linter-adapter.ts`.
  External process execution likewise has one IPC seam,
  `run-external-linter`, backed by registrations in
  `source/app/util/external-linter-registry.ts`; do not create provider-specific
  lint IPC commands. Editor integration is registration-only through
  `markdown-editor/diagnostics/markdown-diagnostic-plugins.ts`.
  Provider-specific code must not call CodeMirror's `linter(...)` or define
  editor-owned lint semantics. If a provider needs a source projection (for
  example LanguageTool's Pandoc/math projection), that transformation belongs
  inside the provider/plugin and must return diagnostics mapped to the original
  source offsets. Flowmark owns the whole lint surface for Pandoc mathematics:
  Markdown structure, the TeX inside math and raw TeX (commands, macros,
  packages, resources), notation, cross-references, citations and TikZ
  compiler findings. Those rules live in the Flowmark package itself
  (`src/flowmark/lint_authoring.py` in pandoc-flowmark), not in this repository.
  Every Flowmark rule has a stable rule id and must be runnable from the
  Flowmark CLI. Rule enablement/severity/options belong to Flowmark config.
  Zettlr supplies only context data (`source/app/util/flowmark-lint-context.ts`:
  macro source paths, active packages, workspace reference resolutions,
  bibliography file paths (`document-bibliographies.ts`, the same files citeproc
  uses), compiler findings) and must not own any rule decision or run
  a CodeMirror linter of its own. Macro-sensitive rules load the declared macro
  sources themselves, so the same checks run from `flowmark-lint`; do not
  precompute a GUI-owned macro inventory for linting.
- **Document lint cache:** every Flowmark lint, from the editor or the agent
  API, goes through `DocumentLintProvider`
  (`source/app/service-providers/document-lint/`). It keys a result by the
  document text hash and a digest of every other input Flowmark reads: the
  fixed vocabulary that the app sends (`FLOWMARK_HOST_VOCABULARY`), the
  Flowmark install (PEP 610 `commit_id`, `flowmarkInstallIdentity`),
  the content hashes of the macro tree, `mathjax-macros.json`, the TikZ
  template graph, the bibliographies and the Flowmark config files,
  `TEXINPUTS`, and the
  reference resolutions that Flowmark receives for the document
  (`flowmarkReferenceContext`: the resolution of each key that the document
  defines or uses, and all defined workspace keys when one of its references
  is missing). A new label in one document therefore makes stale only the
  documents whose resolutions changed. One `LintPass` reads each shared input
  (a content hash, a directory descriptor, the workspace definitions) once for all
  documents of a reconcile, a lookup or a fix plan, and a queued document
  carries the pass that queued it. The cache persists to
  `userData/document-lint-cache.json`. FSAL events and a Flowmark update queue
  every workspace document without a current result for a background worker
  pool. `/v1/lint` with `scope=workspace` or `all` reads only the cache: each
  result carries `current` and `lintedAt`, and a document never linted is
  listed under `pending`. A new input that Flowmark reads must go into
  `inputsKey`, or results go stale silently. Adding or removing a resource
  file (an image, an `\input` target) does not yet invalidate closed
  documents.
- **Problems view:** the left activity bar and View menu open
  `win-main/sidebar/ProblemsView.vue`. It reads `list-workspace-lint` from the
  document lint cache for the active workspace or all loaded workspaces. It
  shows pending and stale documents; a queue drain broadcasts
  `document-lint-changed` to refresh an open view. Clicking a finding opens
  its document and selects its source range. A finding with a current
  machine `fix` uses `apply-lint-fix`, which checks the cached finding and
  applies its edit through the guarded Fix All transaction.
- **Background work is visible:** a Flowmark format, the background lint
  queue and the startup Flowmark update each register a long-running task
  (`LongRunningTaskProvider`). The status bar names the newest running task
  with its elapsed time; its indicator opens the task list. A routine task
  ends through `settleTask`: a success leaves the list, a failure stays
  listed with its error. New background work registers a task the same way.
- **Fix All:** a Flowmark diagnostic carries a `fix` (a machine-applicable
  edit that keeps the meaning of the text) beside its `suggestions` (edits
  that need the author's choice). Only a `fix` is ever applied without the
  author. The Format menu items `menu.fix_all_document`, `menu.fix_all_open`
  and `menu.fix_all_workspace` (also in the Ctrl+P launcher) open
  `win-main/FixAllDialog.vue`. It asks `preview-fix-all`
  (`commands/fix-all.ts`) for a plan: `DocumentLintProvider.planFixes` lints
  each document of the scope, buffer text first, and `fixEdits` takes its
  fixes in source order, skipping overlaps. The dialog shows the count per
  rule and per document; on confirmation `commit-fix-all` applies that plan
  through `runWorkspaceEditTransaction`, which refuses the whole plan when a
  document changed after its hash was taken. One pass applies one round of
  fixes; a fix that exposes another needs a second run.
- The project's own source code is checked by the global ai-review-ci bun
  profile (`just test-commit`, `just test-ci`), not by a repo-local linter.

## Traps (details in agent-memory: `agent-memory search --scope both`)

- The raw production command can report success without a fresh asar. Use `just
  package` or `just verify-build` so the verifier checks the current fingerprint.
- `userData/defaults` is copied once and never pruned; a **stale shipped profile** can
  shadow a custom one in the export menu.
- `packages/pandoc-editor/src/util/math-delimiters.ts` must stay CodeMirror-free (main-process
  bundle).
- The launcher's focus-if-running is **intentional** — quit fully to load a new build.
- The global biome configuration formats every file, the files shared with
  upstream Zettlr included: double quotes, semicolons, sorted imports. Run
  `biome check --config-path ~/ai-review-ci/tool-configs/biome.json --write .`
  before a commit; `qc-ci / qc` fails on an unformatted file.

# Review Guidelines

These are additional requirements for reviewing agent work.
They do not replace the reviewer’s normal role, repo-specific standards, or technical judgment.
They provide the failure model that should shape the review.

The task is not merely to review a PR. The task is to decide whether a completion claim is true under the original objective.
The standard is full, correct, provable completion against the original requirements and repo guidelines.
Anything less is incomplete work that must not be treated as a win.

## Failure Model

Agents systematically produce impressive non-completion.
Common patterns are: polished summaries that imply finished work, caveats that quietly narrow the goal, reclassification without proof, delegated discovery presented as resolution, process language that substitutes for evidence, merged PRs treated as completion, passing checks treated as semantic proof, and artifacts that look substantial while leaving required work unowned.

Treat the agent’s summary, PR description, closing comment, issue closure, “goal completed” statement, and self-reported validations as untrusted.
They may be diagnostic pointers, but they are not evidence that the work is complete.
The evidence is the original issue or task, the code diff, tests, source/runtime facts, review comments, and produced artifacts.

## Decisive Invariants

Preserve the original success condition.
Read the original issue or task before accepting any restatement of it.
Keep its quantifiers intact: “all,” “complete,” "full subset," “zero remaining,” and similar terms cannot be quietly narrowed to examples, partial coverage, known blockers, or whatever the PR happened to touch.

Nothing required may disappear silently.
A required work family must be implemented, explicitly falsified, or validly reclassified with evidence that satisfies the issue’s own standard.
Partial implementation is not completion.
Future work is not completion.
Count reduction is not completion.
Resolved review threads are not completion.
Passing checks are not completion.
Substantial-looking work is not completion.
“Better than before” is not completion.

Goal substitution is the main thing to detect.
Ask whether the submitted work solves the original problem or merely produces a narrower artifact: cleaner metadata, a partial subset, a better explanation, a new issue, a renamed scope, a local workaround, or proof that someone should investigate later.

Technically correct administrative artifacts can be goal substitution.
A well-written issue, comment, audit note, scope statement, or enumeration of remaining work may be required, but it does not complete implementation, testing, proof, or downstream cleanup.
If the original task requires execution, the artifact is only useful insofar as it drives that execution; it must not become the stopping point.

Treat self-scoped remaining-work lists as a severe completion-laundering pattern.
When an agent is asked to enumerate remaining work, the domain is the original full completion requirement, not the agent’s intended subset, the PR’s current shape, a closeability criterion, or the work left after deferral and reclassification.
A valid enumeration subtracts only artifact-proven completed work from the original contract.
Deferrals, routed follow-ups, owner changes, and truthful incompletion notes remain unresolved work unless the original task explicitly made that administrative routing the whole deliverable.

If an agent repeats a narrowed enumeration after being corrected, treat that as a hard misalignment signal, not as an innocent wording issue.
The reviewer should identify the original full requirement, the scope the agent substituted, and the required work hidden by that substitution.

Silent reclassification is not resolution.
If the PR says remaining work is out-of-scope, research-owned, stub-owned, plugin-owned, downstream-owned, or future-owned, require evidence from the relevant source/runtime behavior, repo boundary, or original acceptance criteria.
A sentence in the PR description is not enough.

Ownership boundaries matter.
The submitting repo must prove its own claimed behavior and do the blocker forensics required by its own issue.
Do not require a receiving or downstream repo to classify another project’s internal uncertainty unless the original issue explicitly made that part of acceptance.
When an external issue is created, it should be written for that receiving repo, not for a reader who already knows the submitting repo’s context.

## Evidence Expectations

Review tests as evidence, not as decoration.
Valid tests exercise the real production path or semantic requirement.
Be skeptical of helper-only tests, tautologies, assertions of the implementation’s own output, bypasses around the runtime/plugin/stub path, example-only coverage where the issue required full coverage, weakened assertions, and missing invalid-nearby cases where the fix could overgeneralize.

For plugin work, the evidence should usually distinguish valid generic behavior from invalid nearby ordinary Python and should not hard-code a downstream consumer.
For stubs work, the evidence should be source-backed: the upstream surface exists, the stub matches public behavior, no fake API is added, no Any/object opacity escape is introduced, and inherited-method inflation is not used unless source exposes that surface.

Watch for code-level laundering: hard-coded consumer names, support for local research abstractions as if they were external API, fake stubs, broad Any/object escapes, line suppressions, diagnostic filtering, deletion of required data, broad type widening, and any move that makes checks pass by weakening the problem instead of solving it.

## Before a PR Leaves Draft

A PR is ready when its gates are green and its review feedback has converged. Finished milestones do not make it ready, and neither does a plan card, a PR body, or a green local test run. Every push to a PR branch runs `deterministic-diff`, `delegation-conformance`, `qc-doctor`, `pr-description-checklist` and `thread-resolution`, beside `Unit Tests / Lint` and `qc-ci / qc`. The bridge-burning policy scanner posts threads on the diff as `github-advanced-security`. Its findings land on the branch's own new code.

Read both surfaces before `gh pr ready`:

```bash
gh pr checks <n>
gh api graphql -f query='query { repository(owner:"dzackgarza", name:"zettlr-pandoc") {
  pullRequest(number:<n>) { reviewThreads(first:100) { nodes { isResolved path } } } } }'
```

`thread-resolution` is red while any thread is unresolved, so a red `thread-resolution` says the triage loop has not been run. Triage every substantive thread through `pr-feedback-triage`: a disposition and its evidence on the thread itself, a commit behind any accepted finding, and no thread resolved on intent. Policy findings (`POLICY.FAIL_OPEN`, `POLICY.NO_ERROR_DISCARD`, `POLICY.RUNTIME_DEFAULT`, `POLICY.NO_HIDDEN_CONFIG`, `POLICY.NO_TYPE_ESCAPE`) are the global bridge-burning rules; they are not style notes and they are not waivable by a sentence in the PR body.

The local commit hook exempts this fork from verification. The hosted `Unit Tests / Lint` job builds the packaged app and runs the assembled-app E2E suite on it. Neither a clean commit nor a green local run is evidence about the PR; the run over the branch head is.

## When Acting on Review Feedback

A positive disposition requires a commit.

Do not resolve an accepted review comment until the code/proof remediation is committed and the reply cites the commit.

Never reply “accepted,” “aligned,” “fixed,” “addressed,” or “will address” to a review thread unless the remediation is already committed.
A thread cannot be resolved on intent or future work.

Every substantive review item must receive its visible thread- or surface-local disposition and evidence before resolution.
The canonical field contract and state machine live in [[pr-feedback-triage/SKILL|pr-feedback-triage]]. Do not create top-level disposition ledgers or tracked review-log files.
Migrate legacy ledger-only resolutions by posting the canonical disposition and evidence on each affected thread before treating it as closed.

Review comments are not implementation specs.
The worker must translate accepted feedback into first-principles remediation requirements before assigning implementation.

For each comment:

- Identify the concern.
- Identify the proposed fix.
- Decide whether the concern is true under global + repo policy.
- Decide whether the proposed fix preserves those policies.
- If the concern is true but the fix is wrong, apply a policy-compatible remediation.

## Writing the Review

Write nuanced feedback for an intelligent reader.
Do not force a machine-readable template, a mandatory table, or a simplistic pass/fail label when prose communicates the situation better.
Do make the completion judgment clear: whether the original task can be considered complete, what evidence supports that judgment, and which unresolved requirements block completion if any remain.

Do not foreground effort, progress, good intentions, volume of work, or “substantial” partial implementation when required work remains.
Mention completed pieces only when they are necessary to identify the exact remaining blockers or to prevent redoing already-correct work.
Do not compare incomplete work to “no work done” or “completely fake work”; compare it to the expected standard: the task done correctly, completely, and provably.

When required work remains, lead with the incompleteness and the concrete blockers.
Do not make the reader excavate the missing work from beneath praise, context-setting, or a narrative of what did get done.

Nuance belongs in the evidence and blocker analysis, not in softening the completion standard.
The review should make it easy to finish the work, not easy to feel satisfied with less than the original contract required.
