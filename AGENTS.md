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
  build from source on every start; reflects the working tree. **Works.**
  `just launch` instead routes through the repository's isolated GUI-test
  profile. The desktop launcher starts the packaged build.
- **No browser extension without a request.** A start loads the Vue.js
  devtools extension only with the app option `--vue-devtools`
  (`just launch-desktop --vue-devtools`). The app downloads the extension, and
  that start fails when the download fails. The content script of the
  extension puts an inline script into each frame of a window; a frame that
  has the content security policy of the window refuses it with a console
  error. An e2e run therefore starts the app without the option (#183).
  Proof: `e2e/window-frame-scripts.spec.ts`.
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
  fingerprint is stale. A desktop entry has no shell environment, so the
  script starts the binary under `direnv exec "$HOME"`: the app gets the
  variables of `~/.envrc`, the Agent API token among them (§6). The script
  stops when `direnv` or `~/.envrc` is absent. It retains focus-if-running (intentional — do not
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
- **The templates of a Project go before the settings.** `templateOf`
  (`commands/dir-project-export.ts`) gives an export profile the LaTeX
  template of the Project when its writer is the PDF recipe or a TeX writer
  (`isTexWriter`), and the HTML template of the Project when its writer is an
  HTML writer (`isHtmlWriter`). `makeExport` gives the recipe that template;
  an export without one gets `export.latexTemplate`. Proof:
  `test/project-export.spec.ts`.
- **An export of unsaved text is an export of the document.** A
  `MinimalFile` (`exporter/types.d.ts`) has `path`, the document, and
  `textFile`, the file with the text. `exportDocument` (`commands/export.ts`)
  writes unsaved text to a directory of its own and removes it after the
  export. The recipe runs in the folder of the document and gets the text
  file by its absolute path; a textbundle takes its images from the folder of
  the document; a wikilink resolves to the document. A declared
  `pandoc_working_dir` is read from the folder of the document, and one that
  is no folder refuses the export. A citation library or style of the
  settings or of the Project that is no file refuses the export
  (`writeDefaults`). Proof: `test/export-document.spec.ts`,
  `test/project-export.spec.ts`.
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

- The agent API listens on `127.0.0.1:27412` only. It serves the OpenAPI
  routes and, at `/mcp`, the same operations as an MCP server
  (`source/app/service-providers/agent-api/mcp-endpoint.ts`).
- **Each request carries the token.** A caller sends
  `Authorization: Bearer <token>`, where the token is the value of
  `ZETTLR_AGENT_API_TOKEN` in the environment of the app. `dispatch`
  (`http-server.ts`) verifies it before it reads the body or selects a
  handler, and answers 401 `UNAUTHORIZED` without it. A loopback caller has no
  exemption: each tunnel to the listener arrives from loopback. Only
  `GET /openapi.yaml` and `GET /openapi.json` answer without the token, so an
  importer can read the contract; the document declares the scheme
  (`bearerToken`), which makes the import of a Custom GPT Action ask for the
  key. An MCP tool call is a request of the same caller to the same listener
  and carries the same header.
- **The token has one home, `~/.envrc`.** No configuration key and no file of
  the app holds it. An app with an enabled API and no token in its
  environment does not start (`AgentApiTokenRequiredError`, a native error
  dialog); `agentApi.enabled: false` starts it without the API. Each owner of
  a process gives the variable: `zettlr-pandoc-boot` starts the app under
  `direnv exec "$HOME"`, the tunnel unit sends the header through
  `MCP_EXTRA_HEADERS`, `zettlr-pandoc-review-diff` reads the variable and
  stops without it, and a development start (`just launch`,
  `just launch-desktop`) takes it from the shell. An e2e run makes a token of
  its own (`AGENT_API_TOKEN` in `e2e/support/electron-app.ts`).
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
  `~/.envrc`, so it needs no inbound port and no public hostname. The unit
  gives tunnel-client the header `Authorization: Bearer <token>` in
  `MCP_EXTRA_HEADERS`, made by a shell from the environment so that the token
  is in no argument list; tunnel-client sends it with each request to `/mcp`.
  A header that the ChatGPT app forwards replaces a static header of the same
  name, so the app in ChatGPT has no authentication of its own. The unit sets
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
- **An inline widget states how it stays on its row.** The view puts an
  image of no width (`cm-widgetBuffer`) on each side of a widget, and a
  browser can end a row beside an image. A widget of `base-renderer.ts`
  therefore has the property `rowJoin` (`RowJoinedWidget`): `"box"` for one
  box that no row end divides (an inline equation, a wikilink chip), `"text"`
  for text with row ends of its own (a citation, a cluster of reference
  chips), `null` for a widget that fills its row (display math). The renderer
  puts a mark (`cm-row-join`) over a joined widget and the character that
  touches it on each side; no row ends in the mark, and a space is never in
  it. The mark is inclusive: a mark that is not inclusive does not hold a
  widget that starts or ends at its edge. A pill inside a widget with text
  around it goes into an element with `ATOMIC_INLINE_JOINT_CLASS`. A widget
  without `rowJoin` (an image, a task marker) is not joined. Proof:
  `e2e/inline-widget-line-breaks.spec.ts`.
- **The badges of a definition have room in the flow of its line.** The
  reference badges are an overlay (`render-reference-definitions.ts`). The
  layer puts an anchor, a widget without text, at the end of each line of a
  definition in the viewport. It gives the anchor the size of the badge
  groups of that line and puts the groups on it. An anchor without room after
  the text goes to a row of its own, so no badge covers text. A widget that
  replaces the line of a definition (the header of a fenced div) puts
  `referenceBadgeAnchor(view)` in its DOM and calls
  `referenceBadgeAnchorsRemoved(dom)` in its `destroy`; the layer uses that
  anchor. A line whose end another renderer replaced has no anchor: its
  badges are after the end of the line, kept inside the layer, so they add no
  horizontal scroll. Proof: `e2e/titled-fenced-divs.spec.ts`,
  `test/editor-reference-badges.spec.ts`.
- **An equal value causes no transaction.** `setWorkspaceReferences`,
  `setWikilinkResolutions`, `setCompletionDatabase`, the collaboration session
  store and `modeSwitcher` (`renderers/index.ts`) dispatch or reconfigure only
  for a changed value. A `Compartment.reconfigure` makes the view draw its
  content again. `configField` keeps its object for a configuration update
  with equal values, so a renderer can compare the field by identity in
  `inputsChanged`.
- **A change of one collaboration session costs work for its document only.**
  The window store (`pinia/document-collaboration-store.ts`) holds each
  session as the object that the main process sent: the map of sessions is
  shallow (`shallowReactive`), each session is raw (`markRaw`), and a new
  state replaces the session through `setSession`. No code changes a stored
  session in place, and no watcher is deep. A value that the store derives
  from a session (the cards, the review rows) is made one time for one
  session object. A session whose annotation set is equal to the shown one
  keeps the shown `annotations` object, so the editor watches that object by
  identity. The Annotations view reads the workspace state again only when
  its list of paths has a new member or lost one (#126). Proof:
  `test/annotations-sidebar.spec.ts`,
  `test/annotations-panel-animation.spec.ts`.
- **The editor takes one new width for one slide of a side pane.** A side
  pane of the main window slides for 180 ms. `paneSlide`
  (`win-main/util/pane-slide.ts`) gives the panes their final sizes in one
  step and plays the slide as an animation of `flex-grow` from the old sizes.
  For the time of the slide the frame of the editor (`.editor-frame`) has
  the width of the end state and is anchored to the side that does not move,
  so the document wraps one time. On an open, the part of the editor pane
  that the side pane did not reach yet is empty; on a close, the editor pane
  clips its frame. A new pane that
  slides beside the editor goes through `paneSlide`; no CSS transition
  changes the width of the editor. Proof: `e2e/pane-slide.spec.ts`.
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
- **Background processes wait for a pause in the editor.** The lint queue
  (`DocumentLintProvider.work`) starts no Flowmark run until the document
  authority had no editor update for one second
  (`DocumentManager.lastEditorInputAt`, `INPUT_IDLE_MS`). A run that started
  goes to its end. The lint of the active document is not in the queue and
  does not wait. New background work that starts processes while the author
  can type waits on the same time. Proof:
  `test/document-lint-idle-gate.spec.ts`.
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
- **Proof:** `test/citeproc-unreadable-style.spec.ts`,
  `e2e/unreadable-citation-style.spec.ts`,
  `test/citeproc-library-parse-thread.spec.ts` (the event loop during a
  parse, the calls that do not wait), and `e2e/citation-library-thread.spec.ts`
  (the thread program in the packaged app; run `just package` before it).

### 13. Assembled-app E2E runs

- `just test-e2e` and `just test-e2e-file <spec>` run the specs of `e2e/`. A spec
  that starts the app through `attach` (`e2e/support/electron-app.ts`) runs
  `electron-forge start`: a development build of the working tree for each start.
  `e2e/application-lifecycle.spec.ts` and `e2e/citation-library-thread.spec.ts`
  start the packaged binary. `currentPackagedBinary` refuses a build whose
  source fingerprint is not that of the tree: run `just package` before such a
  spec. The packaged app writes its log to a file; such a spec reads the
  shutdown line through `readAppLog`.
- **The run owns the display.** With `DISPLAY` unset the recipe starts the whole
  Mocha process under one `xvfb-run`; a spec starts no X server of its own.
- **The run owns its session bus.** The recipe starts the Mocha process
  under `dbus-run-session` with `scripts/e2e-session-bus.conf`, a bus without
  services. A desktop notification of the app of a run goes to that bus and
  not to the desktop of the author. The stock session configuration starts a
  notification daemon on request, and that daemon draws on the compositor of
  the author. A spec that needs a session service starts it on the bus of
  the run.
- A Chromium probe of test-support code reports its exit code or signal, its
  output and the X server errors when it fails (`test/visual/display-probe.ts`).
- An e2e run and a `just package` build each need most of the memory of this
  workstation. Run one at a time. A start from the desktop launcher runs
  `just package` when the source changed, and the build replaces `.webpack`
  under a running e2e start: that run stops with "Cannot find module
  '.webpack/main/index.cjs'" or a closed page. Run it again after the build.
- **A click that closes its page goes through `clickToClose`.** Playwright
  stops each action of a page that closes before the action ends, so a click
  whose handler closes the window races the close. `clickToClose` and
  `requestWindowClose` (`e2e/support/electron-app.ts`) act in a later task
  of the page, as `requestQuit` does.
- **A function that runs in the page declares no named function.** tsx
  compiles a spec with esbuild's `keepNames`, which puts a call of the helper
  `__name` around each function that a `const` or a declaration names. The
  page has no such helper, so `page.evaluate` stops with `__name is not
  defined`. A callback that is an argument has no name and is not wrapped.
- **A native message box is not a page.** Playwright does not see it. A spec
  finds the box by its title with `xdotool`, captures it with ImageMagick
  `import`, and presses a key in it (`e2e/quit-with-open-review.spec.ts`). The
  CI toolchain installs both tools (`scripts/setup-ci-toolchain.sh`). Such a
  spec runs on the display of the run only: with `DISPLAY` set, the keys go
  to the desktop of the author.
- **A file dialog is drawn on the display of the run.** `attach` starts the
  app with `--xdg-portal-required-version` at a version that no portal has
  (`NO_PORTAL_FILE_CHOOSER_VERSION`). Without the option the desktop portal
  of the session draws the dialog on the desktop of the author. A spec
  accepts a GTK file chooser with the mnemonic of its button (`alt+s` for
  Save, `alt+o` for Open): the Return key does not accept it while the name
  field has the focus (`e2e/refused-save.spec.ts`). A dialog that opens in a
  folder of the fixture (`dialogPaths` of the configuration) shows no folder
  of the author (`e2e/import-files.spec.ts`).
- **Shared helpers.** `e2e/support/native-dialog.ts` finds, captures and
  answers a native window. `e2e/support/panes.ts` gives the panes of a
  window and opens a document in one.

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
- **A discard changes only the state in memory.** `discardCollaboration`
  does nothing for a document with no review and no annotations in memory.
  The sidecar of such a document is the state of another time (the author
  closed the document without it, or this version cannot read the file),
  and the discard leaves the file as it is.
- **A sidecar whose document has no file is named.** A deleted document
  keeps its sidecar, and a move that cannot write the sidecar at the new
  key leaves it at the old one. `_sidecarsOfNoDocument` gives each such
  file in `WorkspaceCollaborationListing.ownerless`: a readable sidecar of a
  path inside an open workspace that is there, where the application
  reaches no file and no loaded document has the path. The Annotations
  view shows it with the action "Move the file aside". A sidecar of a path
  outside every open workspace is not named.
- **`closeWindow` answers whether the window may close.** The window
  provider closes the `BrowserWindow` only for `true`, and gives the
  documents provider the function that repeats the close.
- **`closeFileEverywhere` answers whether the document closed.** It
  detaches before it closes a tab, so a refused close leaves the tabs and
  the buffer. A caller that removes the file afterwards (`file-delete`, the
  overwrite of `file-new`) stops on `false`.
- **A sidecar that cannot be read is kept.** `CollaborationSidecarStore`
  replaces or removes a file only after its last read of that file gave a
  sidecar or no file (`examined`). A file that this version cannot read (a
  later schema, damaged bytes) refuses each write of its document, so a new
  annotation is refused with `PERSISTENCE_FAILED` and the bytes stay.
  `inventory()` gives the readable sidecars and names each unreadable file
  with its cause; the Annotations view and a message at the open of the
  document show the file with the action "Move the file aside"
  (`set-aside-collaboration-sidecar`), which renames the file in the sidecar
  directory and keeps its bytes. `list()` is the complete set or an error:
  the Agent API listings reject while an unreadable file exists.
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
- **A restored session goes out after the buffer has its text.**
  `reattachCollaboration` broadcasts nothing. `_reattachCollaborationSidecar`
  applies the working text of the sidecar and then broadcasts the state. The
  window keeps the session that it gets for a document, and an editor shows a
  review only while its text is the working text of that session.
- **A removed file closes only a document whose text is on disk.** The
  watcher reports the removal of the file of a tab (`unlink`). A document
  without unsaved text closes with its tabs. A document with unsaved text
  stays loaded with its tabs, and each window that shows it gets one
  message (`FILE_REMOVED_KEPT_CHANNEL`): a save writes the file again, or, for a
  document with a review, the save is refused and the message offers
  "Save a copy…". The watcher follows the path through the removal: a
  file that is written again arrives as `add`, which the provider handles
  as a change (the `add` of its own save is not a change).
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

### 15. Failed application commands

- **A command that cannot do its work throws.** A command
  (`service-providers/commands/`) throws an `Error` whose message names the
  file or folder and the cause. It does not write the cause to the log and
  answer `false`: `false` is a value of the contract of some commands, and a
  caller cannot tell it from a failure.
- **The dispatcher shows each failure once, in the window that started the
  command.** `CommandProvider.run` (`commands/index.ts`) logs the error,
  sends it on `command-failed` (`types/common/command-failure.ts`) to the
  window whose renderer started the command, and rejects to the caller. The
  main window gets the failure of a command that the application started (a
  menu item, a second instance) and of a command whose window is gone. Each
  window shows the message as an error (`window-register`). A command that
  runs a command (`force-open`, `tutorial-open`) passes the same error on;
  the dispatcher shows it one time.
- **A caller does not show a rejection of a command.** It logs the rejection
  (`reportError`) and stops its own work: no success message, no further
  step. A second message in the caller repeats the first.
- **`CALLER_SHOWS_FAILURE`** names the commands that a window runs on its
  own (a lint pass, a figure render, a hover preview). Their callers show the
  failure in their own place, and the dispatcher broadcasts nothing for them.
  A new command of that kind goes into the set; a command that an action of
  the author starts does not.
- **A command that prompts answers its contract.** A command that showed the
  cause itself in a native dialog or in the error window (`dir-rename`, the
  Project export) returns its value and does not throw as well.
- **A Project export gives one message for all its profiles.** One profile
  that does not export does not stop the other profiles. When a profile did
  not export, `dir-project-export` opens one error window that names each
  such profile with its cause, shows no success notification and answers
  `false`. A new error window closes the one before it, so a command that
  can fail in more than one part collects the causes and opens one window.
- **Proof:** `e2e/command-refusal.spec.ts`,
  `e2e/project-settings-refusal.spec.ts`, `test/project-export.spec.ts`,
  `e2e/project-export-failure.spec.ts`.

### 16. Writes of authored text files

- **One writer.** `writeTextFile` (`fsal/util/write-text-file.ts`) writes each
  text file that the author owns: a document (`FSAL.writeTextFile`: a save,
  `save-copy`, a tag rename, a duplicate), a Quarto manifest, `.zettlrignore`,
  `.ztr-directory`, the custom CSS, a defaults file, a Lua filter, the snippets
  and the user dictionary. A new path that writes such a file calls it, and
  does not call `fs.writeFile`.
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
  removed file whose document has no unsaved text (§14). The temporary file `<name>.<number>` gets `add` and `unlink`
  events. It is of no known type, so the file filters hide it (§10).
- **Proof:** `test/fsal-write-text-file.spec.ts`,
  `test/fsal-watcher-events.spec.ts`, `e2e/save-after-typing.spec.ts`,
  `e2e/refused-save.spec.ts`.

### 17. A main window without a working renderer

- **The author gets a prompt.** `recoverRenderer`
  (`service-providers/windows/recover-renderer.ts`) follows each main window.
  When Electron reports `render-process-gone`, a native message box names the
  reason and the exit code and offers "Load the window again" and "Close the
  window". When Electron reports `unresponsive`, a second box offers the same
  two actions and "Keep waiting", which is its default; the box goes away
  when the window responds again. The prompt is native because a window
  without a renderer draws nothing and takes no input.
- **The documents are in the main process.** A new renderer shows the
  unsaved text of each document. Text that a hung renderer did not send to
  its document is lost with that renderer; the prompt says so.
- **Each action but "Keep waiting" starts a new renderer first.** "Close the
  window" loads the window and then closes it on the usual path
  (`closeWindow`, §14), so the unsaved-changes prompt runs and a cancel leaves
  a window that works.
- **A hung renderer is ended before the load.**
  `webContents.forcefullyCrashRenderer()` ends it, and the load starts when
  Electron reports that exit: a load that starts before the exit does not
  happen.
- **No message goes to a window without a renderer.** `broadcastIPCMessage`
  leaves out a window whose `webContents.isCrashed()`. Main-process code that
  tells every window something calls `broadcastIPCMessage`; it does not loop
  over `BrowserWindow.getAllWindows()` with `webContents.send`. Code that
  tells some main windows something calls `WindowProvider.tellMainWindows`
  (`windows/tell-main-windows.ts`), which leaves out the same windows and
  gives the message to the main window that the author used last when no
  addressed window can take it. A window reads the whole state when it
  loads.
- **Other windows.** `attachLogger` records the reason for each window. Only
  main windows have the prompt.
- **Proof:** `e2e/renderer-recovery.spec.ts` (a killed renderer, a renderer
  in an endless loop, and a close of a stopped window). It answers native
  message boxes, so it runs on the display of the run only (§13).

### 18. Controls that a surface paints itself

- **The window chrome paints every control.** `generic.css`
  (`common/vue/window/assets`) gives each `input`, `select`, `textarea` and
  `button` of a window the look of the platform. Its dark rules have the
  weight of two classes and two elements (`body.linux.dark button`), which is
  more than the rule of a component for its own control.
- **A surface that states the whole painting of its controls carries
  `self-painted-controls`.** The platform rules leave out each control in a
  subtree with that class, so the rules of the surface decide with any
  weight. The collaboration surfaces carry it: the Annotations view, the
  inline thread, the review bar, the review chunk, the create-annotation
  dialog and the two delete confirmations. The Replace All and the Fix All
  confirmations carry it too.
- **A portal is not in the subtree of its component.** A dialog that reka-ui
  puts on `body` carries the class on its own content element, and no rule
  for it is nested in the rule of the view that opens it.
- **A surface with the class states every property that the platform rules
  set** (background, colour, border, radius, padding, font) for each control
  in it. A control without such a rule has the look of the browser.
- **Proof:** `e2e/annotation-button-colours.spec.ts` (each control of each
  collaboration surface, in dark and in light mode, has the colour of its
  token and the same painting with and without the platform class),
  `e2e/search-replace.spec.ts` and `e2e/fix-all.spec.ts` (the two
  confirmations).

### 19. A file that cannot be read

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
  (`service-providers/search`) does not stop at a file that it cannot read.
  It names each such file with the cause: the broadcast `search-unread` for
  the Search view, which lists the files above the results, and the list
  `notSearched` of `GET /v1/workspace/search`. The Replace All confirmation
  says that those files keep their text. An error that is no filesystem
  error ends the search with the failure `stopped`, which names the file.
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
  set; the dispatcher shows the message (§15).
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

### 20. File import

- **An import replaces no file.** `makeImport` (`commands/importer/index.ts`)
  puts each file into the import folder under a name that the folder does
  not have. `placeFile` (`importer/place-file.ts`) copies with
  `COPYFILE_EXCL`, so a file that appears between the check and the copy is
  kept too. A new import path places its files through `placeFile`.
- **Each file has a result.** `makeImport` answers one `ImportOutcome` for
  each file: `imported`, or a refusal with its cause (`destination-exists`,
  `source-missing`, `unknown-format`, `no-profile`, `malformed-bundle`,
  `conversion-failed`, `filesystem-error`). One refused file does not stop
  the other files of the list.
- **A bundle that would replace a file is refused whole.** A TextBundle or
  a TextPack is refused when the folder has its note or one of its `assets/`
  files. The importer examines every destination before the first copy. The
  note of a TextPack takes the name of the pack file.
- **Pandoc writes to a scratch directory.** `convertFile` gives pandoc a
  directory of its own for the defaults file and the output, and places the
  output afterwards. The cause of a failed conversion has the exit code and
  the error output of pandoc. `runPandoc` (`app/util/run-pandoc.ts`) is the
  one start of pandoc for the importer and the exporter.
- **The command shows the refusals once.** `import-files` throws one error
  that names each file that was not imported with its cause; the dispatcher
  shows it (§15). A cancelled dialog is a choice and shows nothing.
- **Proof:** `test/import-files.spec.ts`, `e2e/import-files.spec.ts`.

### 21. Authored files outside the workspaces

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
  command (§15).
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
  (§15) or by `showRefusal` in the window that asked.
- **Proof:** `e2e/export-open-refused.spec.ts`, `e2e/preferences-open-refused.spec.ts`,
  `test/menu-file-navigation.spec.ts`, `test/assets-authored-files.spec.ts`,
  `e2e/assets-refused-save.spec.ts`.

### 22. Data files of the application

- **What they are.** The application keeps its state in files of `userData`:
  `config.json`, `tags.json`, `targets.json`, `stats.json`, `documents.yaml`
  and `window_state.yml`. A `PersistentDataContainer`
  (`common/modules/persistent-data-container`) holds each one in memory and
  writes it one second after its last change.
- **A write that fails is shown.** The constructor of a container requires a
  `StoreWriteFailureHandler`. In the app it is `showStoreWriteFailure`
  (`app/util/show-store-write-failure.ts`): it logs the failure and opens one
  error window that names the file and the cause. The data stays in memory,
  so the change holds until the application closes. A new container gets the
  same handler; a spec gives `unexpectedStoreWriteFailure`
  (`test/store-write-failure.ts`), which stops the spec.
- **The user dictionary has the same handler.** `DictionaryProvider` writes
  `user.dic` through `writeTextFile` at each added word. A failed write
  releases the file lock, goes to `showStoreWriteFailure`, and the next word
  writes the whole dictionary again.
- **A refused setting is shown at its field.** The config provider checks
  each value against the rule of its setting (`config-validation.ts`) and
  keeps the old value for a refused one. The Preferences window writes a
  field through `submitFormValue` (`pinia/config.ts`), which answers the
  reason, and `FormBuilder` shows it under the field (`refusals`) until the
  field gives a value that the rule accepts. Code that writes a setting it
  built itself calls `setConfigValue` or `setConfigFromForm`, which throw.
- **Proof:** `e2e/settings-write-refused.spec.ts`,
  `e2e/preferences-refused-value.spec.ts`,
  `e2e/user-dictionary-write-refused.spec.ts`.

### 23. The order of a folder

- **A control changes the folder that the author names.** Three controls
  change the display, the sort, the direction and the grouping of a folder:
  the context menu of the folder, the Properties of the folder and the
  Workspaces menu. The Workspaces menu changes the selected folder
  (`openDirectory`; a click on a file selects its folder) and names it in
  the item `explorer-target`. It never changes a folder that it does not
  name.
- **One set of choices.** `file-manager/util/explorer-view-menu.ts` owns the
  menu items, the choices and the functions that write them
  (`setSort`, `setDirection`, `setMetadataKey`, through
  `updateExplorerDirectory`). A new control of the order of a folder uses
  them.
- **The direction keeps the sort.** A change of the direction keeps the sort
  and its metadata field; a change of the sort keeps the direction. The
  Properties show each sort of the folder, a metadata field too, and the
  field of a metadata sort.
- **Proof:** `e2e/explorer-metadata-sort.spec.ts`,
  `e2e/folder-metadata-problems.spec.ts`, `e2e/quarto-bound-book.spec.ts`.

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
- The global biome configuration formats the code files, the files shared
  with upstream Zettlr included: double quotes, semicolons, sorted imports.
  Before a commit, format the code files that the commit changes:
  `bun x --package @biomejs/biome biome check --config-path ~/ai-review-ci/tool-configs/biome.json --write <files>`.
  Give it files, not a directory, and no Markdown file: Biome reads Pandoc
  Markdown as CommonMark and turns YAML front matter into a heading, which
  changes the fixtures of `test/fixtures` (dzackgarza/ai-review-ci#496). The
  hosted `bun-biome` check is recorded debt: it does not fail `qc-ci / qc`.

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
