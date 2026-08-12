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
| `just launch` | Dev mode through `scripts/test-gui/index.mjs`; uses the isolated `resources/test-cfg` profile. |
| `just launch-desktop` | Dev mode (`electron-forge start`) with the normal user configuration. **This is the desktop path that works.** |
| `just install-desktop-launcher` | Install the repo-owned Hyprland launcher and desktop entry under `~/.local`. |
| `just package` | Production build and freshness verification (`electron-forge package`) → `app.asar`. |
| `just verify-build` | Build, then prove the asar is fresh + built from HEAD (observability). |
| `just verify-build-only` | Fast staleness check of the existing artifact (no rebuild). |
| `just export-headless PDF.yaml file.md` | Run the real `makeExport` headlessly (no GUI) — debug exports. |

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
- **"App isn't showing my change"?** Run `just verify-build-only`. If the asar is
  stale, the desktop launcher runs `just package` before it starts the binary.
  Use `just launch-desktop` for a direct development run.
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

- The raw production command can report success without a fresh asar. Use `just
  package` or `just verify-build` so the verifier checks the current fingerprint.
- `userData/defaults` is copied once and never pruned; a **stale shipped profile** can
  shadow a custom one in the export menu.
- `source/common/util/math-delimiters.ts` must stay CodeMirror-free (main-process
  bundle).
- The launcher's focus-if-running is **intentional** — quit fully to load a new build.

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

> Optimized tool-use workflow for agents: follow the procedures in this file.
