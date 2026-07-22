<!-- agent-memory:start -->
# Agent memory

This repository uses the central agent memory vault at `/home/dzack/.agent-memory-vault`.

Project memory key: `projects/github.com__dzackgarza__zettlr-pandoc/index`.

Repository `.agents` and `.hermes` paths are symlinks to the same vault-owned project directory.

Before changing architecture, search both project and global memory:

```bash
agent-memory search --scope both "<task or subsystem>"
```

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
  `mathjax-macros.json`, `logs/`.

## Task runner: `just`

All project workflows route through the top-level `justfile`. **`just --list`** is
the source of truth for recipes; do not run builds/exports/tests by hand when a
recipe exists. Key recipes (see the `justfile` for the exact commands):

| Recipe | What it does |
|---|---|
| `just launch` | Dev mode (`electron-forge start`) — builds from source and runs. **This is the path that works.** |
| `just package` | Production build (`electron-forge package`) → `app.asar`. **Currently broken** (see Build). |
| `just verify-build` | Build, then prove the asar is fresh + built from HEAD (observability). |
| `just verify-build-only` | Fast staleness check of the existing artifact (no rebuild). |
| `just export-headless PDF.yaml file.md` | Run the real `makeExport` headlessly (no GUI) — debug exports. |

## Build process

- **Dev mode** — `electron-forge start` (`just launch`). Webpack dev build from
  source on every start; reflects the working tree. **Works.** The launcher uses
  this.
- **Production** — `electron-forge package` (`just package`) → `out/Zettlr-Pandoc-linux-x64/resources/app.asar`.
  webpack configs: `webpack.main.config.js` (Node/main target), `webpack.renderer.config.js`
  (browser/renderer), assembled by `forge.config.js`. **Known-broken:** the webpack
  stage can fail silently and exit 0 without (re)writing `app.asar`, shipping stale
  bytes. **Do not trust its exit code.**
- **Build observability** — `scripts/verify-build.py` (`just verify-build`). Proves the
  asar was built from the current commit via the `__GIT_COMMIT_HASH__` string that
  `DefinePlugin` bakes into the bundle (`webpack.{main,renderer}.config.js`, sourced
  from `scripts/get-git-hash.js`, referenced by `source/win-about/Debug-Tab.vue`).
  Run `just verify-build-only` to instantly answer "is my installed app actually
  current?".

## The global-app launcher

Desktop entry → wrapper → splash → boot script:

- `~/.local/share/applications/zettlr-pandoc.desktop` (`StartupWMClass=zettlr-pandoc`)
- `~/.local/bin/zettlr-pandoc-dev` — opens the floating kitty boot splash (Hyprland
  float/center via `hyprctl dispatch`).
- `~/.local/bin/zettlr-pandoc-boot` — the actual launcher. **Dev mode**
  (`electron-forge start`), focus-if-running (intentional — do not "fix"),
  MathJax-macro refresh (below), Hyprland window-class detection (`class == zettlr-pandoc`),
  fail-loud on timeout. It deliberately does **not** use the packaged build.
- Launcher log: `~/.cache/zettlr-pandoc-dev.log`.

## System-specific integrations

### 1. MathJax macros (editor math rendering)

- **Source of truth:** `~/.pandoc/styles/macros` (the user's ~1600-macro corpus).
- **Generator:** `~/.pandoc/bin/generate-mathjax-config.py` → MathJax 3 `tex.macros`
  JSON. Run on every launch by `zettlr-pandoc-boot`, written straight into
  `~/.config/Zettlr-Pandoc/mathjax-macros.json`.
- **App load:** `source/app/util/load-mathjax-macros.ts` (loader + `seedDefaultMacros`),
  seeded and served via the `mathjax-macros` IPC in `source/app/lifecycle.ts`
  (registered **before** `boot()` to win the onboarding-window race).
- **Format/validation:** `source/common/util/mathjax-config.ts` (`parseMathJaxMacros`;
  throws on malformed — a bad corpus file breaks all editor math).
- **Render:** `source/common/util/mathtex-to-html.ts` (`initializeMathJax`, local
  CommonHTML), wired in `source/common/modules/window-register/index.ts`.
- Editor macros vs export macros are independent: LaTeX export lets the **template**
  own macros (`\providecommand` injection yields to it).

### 2. LaTeX math delimiters `\[ \]` and `\( \)`

Upstream Zettlr only recognizes `$`/`$$`. This fork adds the LaTeX delimiters, and
they must be threaded through **four** layers:

- **Parser:** `source/common/modules/markdown-editor/parser/math-parser.ts` —
  `blockMathParser` (opens on `\[`, closes on `\]` incl. a trailing `.\]`),
  `inlineBracketMathParser` (handles `\( \)` **and** `\[ \]` mid-paragraph, spanning
  newlines; runs `before: 'Escape'` or the backslash opener is eaten as an escape).
- **Registered:** `source/common/modules/markdown-editor/parser/markdown-parser.ts`.
- **Shared pure helpers:** `source/common/util/math-delimiters.ts`
  (`MATH_DELIMITERS`, `mathDisplayForOpen`, `stripMathDelimiters`). **This module must
  import nothing (no CodeMirror/lezer)** — `markdown-to-html` runs in the main
  process, and dragging the editor graph into that Node bundle breaks the webpack
  build.
- **AST:** `source/common/modules/markdown-utils/markdown-ast/index.ts` (treats `\[`
  and `\(` code marks as math).
- **HTML (`md2html`):** `source/common/modules/markdown-utils/markdown-to-html.ts`.
- **Live editor widget:** `source/common/modules/markdown-editor/renderers/render-math.ts`.

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
  + `getCustomProfiles()`, with custom profiles overriding same-named defaults.

### 4. Startup preflight

- `source/app/util/preflight.ts`, called from `source/app/util/environment-check.ts`
  after `fixPath()`. Fails loud (native dialog + `app.exit(1)`) if `pandoc`, `just`,
  `latexmk`, `pdflatex`, `biber`, or `~/.pandoc/justfile` are missing in the app's
  runtime environment.

## Debugging entry points

- **Export not working?** `just export-headless PDF.yaml <file>.md` runs the literal
  `makeExport` headlessly (`scripts/harness/`, electron stubbed at `require`), building
  the same profile list the GUI sees — reproduces export bugs without the app.
- **"App isn't showing my change"?** `just verify-build-only` — if the asar isn't
  built from HEAD, the packaged build is stale (use `just launch`/dev mode). The
  launcher already avoids this by running dev mode.
- **Editor math not rendering?** `test/editor-latex-delimiters.spec.ts` and
  `test/editor-math-widget.spec.ts` drive the parser and a real `EditorView`
  headlessly. Check `~/.config/Zettlr-Pandoc/mathjax-macros.json` has the macro
  (regenerated on launch).
- **Logs:** launcher `~/.cache/zettlr-pandoc-dev.log`; app `~/.config/Zettlr-Pandoc/logs/`.
- **In-editor markdown linter** is `remark-lint`
  (`source/common/modules/markdown-editor/linters/md-lint.ts`); its rule set is
  hard-coded there (not GUI-configurable). The project's own linter is ESLint
  (`eslint.config.mjs`).

## Traps (details in agent-memory: `agent-memory search --scope both`)

- Production `electron-forge package` can exit 0 while producing a **stale/no** asar —
  always confirm with `just verify-build`.
- `userData/defaults` is copied once and never pruned; a **stale shipped profile** can
  shadow a custom one in the export menu.
- `source/common/util/math-delimiters.ts` must stay CodeMirror-free (main-process
  bundle).
- The launcher's focus-if-running is **intentional** — quit fully to load a new build.
