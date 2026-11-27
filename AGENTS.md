> **Planning migration — Spec Kit and itree**
>
> Select the work-unit issue with itree. Use Spec Kit to plan and execute the work.
> The issue body and comments hold the current plan, tasks, progress and evidence.
> Earlier instructions that assign this work to vault cards or a separate task list
> identify records to migrate. Match each obligation to its owning issue. Preserve
> task IDs, order, prerequisites, acceptance criteria and evidence. Verify the transfer
> on the issue before retiring the old tracker. An open obligation stays open.

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

The vault card is authoritative. Repository files that restate a plan — a PR body,
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

Use Spec Kit to plan each itree work unit. Its GitHub issue owns the current plan, tasks and progress.

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
| `just test-file test/x.spec.ts`         | Run one unit spec.                                                                                             |
| `just test-e2e-file e2e/x.spec.ts`      | Run one assembled-app spec on the packaged build of the tree ([§13](docs/agents/e2e-runs.md)).                                            |

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
  asar was built from the commit at the start of the build (a commit during the
  build moves `HEAD`, not the bundle) via the `__GIT_COMMIT_HASH__` string that
  `DefinePlugin` bakes into the bundle (`webpack.{main,renderer}.config.js`, sourced
  from `scripts/get-git-hash.js`, referenced by `source/win-about/Debug-Tab.vue`).
  Run `just verify-build-only` to instantly answer "is my installed app actually
  current?".
- **The source fingerprint covers the inputs of the package only.**
  `scripts/desktop/zettlr-pandoc-source-fingerprint` hashes the index, each
  unstaged change of a tracked file, and the name and content of each
  untracked file that git does not ignore. It leaves out the trees that have
  no path into the packaged app: `test`, `e2e`, `scripts/desktop`,
  `scripts/harness`, `.github`, `AGENTS.md`, `HANDOFF.md` and `docs`. A change
  there does not make the package stale. Each other path is an input, so a
  new path causes a rebuild until it is left out. `static/` and `resources/`
  are inputs (webpack copies them), and so is `HELP.md` (the Agent API
  imports it). The boot script compares the fingerprint with the stamp of
  the last package. Proof: `test/source-fingerprint.spec.ts`.
- **A build that a signal ends fails.** `electron-forge package` runs its
  subcommand `electron-forge-package.js` as a child process through
  commander 11, which exited 0 for a child that a signal ended (#71: earlyoom
  sends SIGTERM to the compile). `patches/commander@11.1.0.patch` makes the
  command exit 128 + the number of the signal, and `verify-build.py` names the
  signal. Commander 12 fixes the cause (tj/commander.js#2023, exit 1); drop
  the patch when Forge depends on it. Proof:
  `test/forge-subcommand-signal.spec.ts`.

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
  variables of `~/.envrc`, the Agent API token among them ([§6](docs/agents/agent-api.md)). The script
  stops when `direnv` or `~/.envrc` is absent. It retains focus-if-running (intentional — do not
  "fix") and fail-loud behavior on build or launch failure. An app "already
  runs" when it holds the `SingletonLock` of the profile of the start
  (`profile_running`); a window of the class `zettlr-pandoc` does not decide,
  as an app of another profile has the same class. The class is only how the
  script sees that the window of its own start is up.
- Launcher log: `~/.cache/zettlr-pandoc-dev.log`.
- The steps of a start, the macro refresh and the time limits:
  [desktop-launcher.md](docs/agents/desktop-launcher.md).

## Rules for every change

- Zettlr never seeds, edits, bundles, prefers or falls back to an
  app-local macro definition file; `~/.pandoc/styles/macros/` owns the
  macros ([§1](docs/agents/macro-system.md)).
- No `startsWith` on a path. A decision of the workspace, the Project or the
  directory of a path calls `isInsideRoot`, `isAtOrInsideRoot` or
  `innermostRoot` ([§11](docs/agents/path-containment.md)).
- A path that enters the application from outside is resolved to its real
  path before it keys a document ([§11](docs/agents/path-containment.md)).
- A new consumer of workspace files lists through the FSAL; it does not walk
  the disk or filter on its own ([§10](docs/agents/file-filters.md)).
- A write of a text file of the author goes through `writeTextFile` or
  `createTextFile`, not `fs.writeFile` or `write-file-atomic`
  ([§16](docs/agents/authored-text-writes.md)).
- A run of an external tool goes through `runProcess`, a check that a tool
  is installed through `probeTool` ([§25](docs/agents/external-tools.md)).
- A command that cannot do its work throws an `Error` that names the file
  and the cause; it does not log and answer `false`
  ([§15](docs/agents/failed-commands.md)).
- Main-process code sends a window a message through `broadcastIPCMessage`,
  `sendIPCMessage`, `replyIPCMessage` or `tellMainWindows`, not
  `webContents.send` ([§17](docs/agents/renderer-recovery.md),
  [§26](docs/agents/commands-keys-menus.md)).
- No `ipcRenderer.sendSync` in the path of a transaction
  ([§9](docs/agents/responsiveness.md)).
- An e2e run and a `just package` build each need most of the memory of this
  workstation. Run one at a time ([§13](docs/agents/e2e-runs.md)).
- A spec that fails is not run many times to see whether it fails again: one
  run with its log kept is read for the cause
  ([§13](docs/agents/e2e-runs.md)).

## Subsystem contracts

Each subsystem of the fork has a contract in `docs/agents/`. Read the file of
a subsystem before you change it, debug it or write a spec for it. The
numbers are stable: a reference `AGENTS.md §N` in the source names the file
of row N.

| § | Read before you change … | File |
| --- | --- | --- |
| | the CodeMirror presentation, the Pandoc parser, widget clicks or decorations made from the syntax tree in `packages/pandoc-editor` | [shared-markdown-editor.md](docs/agents/shared-markdown-editor.md) |
| 1 | a macro, the MathJax projection, or how an export gets its math from `~/.pandoc` | [macro-system.md](docs/agents/macro-system.md) |
| 2 | a parser, AST, HTML or widget path for the delimiters `\[ \]` and `\( \)` | [math-delimiters.md](docs/agents/math-delimiters.md) |
| 3 | PDF export, the `compile-pandoc` recipe, export items, or `resolve-export.ts` | [export.md](docs/agents/export.md) |
| 4 | Quarto manifests, chapters, parts, or the Book module | [quarto-books.md](docs/agents/quarto-books.md) |
| 5 | the startup tool checks or the `PATH` of the app | [startup-preflight.md](docs/agents/startup-preflight.md) |
| 6 | the Agent API, `openapi.yaml`, its token, the MCP endpoints, or the tunnels | [agent-api.md](docs/agents/agent-api.md) |
| 7 | the TikZ render, `packages/tikz-render`, or the Visual TikZ Editor sessions | [tikz.md](docs/agents/tikz.md) |
| 8 | wikilink resolution, chips, lint context, or the export map | [wikilinks.md](docs/agents/wikilinks.md) |
| 9 | editor decorations, widgets, background work, or anything whose cost could follow the document or workspace size | [responsiveness.md](docs/agents/responsiveness.md) |
| 10 | ignore rules, file types, `.zettlrignore`, or the File filters window | [file-filters.md](docs/agents/file-filters.md) |
| 11 | a decision whether a path is in a directory, or real-path resolution | [path-containment.md](docs/agents/path-containment.md) |
| 12 | bibliographies, citeproc, CSL locales, the library thread, or attachments | [citations.md](docs/agents/citations.md) |
| 13 | an assembled-app spec in `e2e/`, the lanes runner, or the hosted check jobs | [e2e-runs.md](docs/agents/e2e-runs.md) |
| 14 | document ids, sidecars, closes, saves, reloads, or the collaboration state of a document | [document-identity.md](docs/agents/document-identity.md) |
| 15 | how a command reports a failure | [failed-commands.md](docs/agents/failed-commands.md) |
| 16 | a path that writes a text file of the author | [authored-text-writes.md](docs/agents/authored-text-writes.md) |
| 17 | renderer crash or hang recovery, or a broadcast to windows | [renderer-recovery.md](docs/agents/renderer-recovery.md) |
| 18 | the painting of controls in a window surface | [self-painted-controls.md](docs/agents/self-painted-controls.md) |
| 19 | the handling of a file or folder that the filesystem refuses to read | [unreadable-files.md](docs/agents/unreadable-files.md) |
| 20 | file import | [file-import.md](docs/agents/file-import.md) |
| 21 | the Assets window, Lua filters, defaults files, `openPath` or `openExternal` | [authored-files-outside-workspaces.md](docs/agents/authored-files-outside-workspaces.md) |
| 22 | `userData` state files, settings validation, or window modes | [application-data-files.md](docs/agents/application-data-files.md) |
| 23 | the sort, display or grouping controls of a folder | [folder-order.md](docs/agents/folder-order.md) |
| 24 | missing workspaces, file-tree rows, or their `fsal-events` listener | [missing-workspace.md](docs/agents/missing-workspace.md) |
| 25 | a run of an external tool | [external-tools.md](docs/agents/external-tools.md) |
| 26 | commands, keys, menu items, link following, or the IPC contracts | [commands-keys-menus.md](docs/agents/commands-keys-menus.md) |
| 27 | the update provider | [application-updates.md](docs/agents/application-updates.md) |
| 28 | a command that edits several documents, or the workspace edit preview | [multi-document-edits.md](docs/agents/multi-document-edits.md) |
| 29 | an HTTP request of the main process or the `got` setup | [http-requests.md](docs/agents/http-requests.md) |
| 30 | the QuickTeX loader or its problem reports | [quicktex.md](docs/agents/quicktex.md) |
| | a failing export, a stale build, the Flowmark lint, the lint cache, the Problems view, background tasks, or Fix All | [debugging-entry-points.md](docs/agents/debugging-entry-points.md) |

`docs/application-lifecycle.md` owns the launch and shutdown protocol.

## Traps (details in agent-memory: `agent-memory search --scope both`)

- A change that removes a surface removes its tests, but not the rules
  that they prove. Before a test of a removed surface goes, find the
  surface that owns the rule now and put the test there in the same
  commit. 51a1b362b deleted the test that an ordinary edit is no review
  decision with the editor label, and the rule had no test until
  ed4346a48.
- The unit suite runs its spec files in four worker processes
  (`.mocharc.js`), and a worker loads a file after files that no serial run
  put before it. A spec file therefore owns the state that it reads: a
  temporary directory of its own, and no module state that another file
  set. `test/setup.js` installs what each file needs before the first one
  (the `electron` stub, the browser globals, the IPC double). A file that
  passes in the suite and fails alone (`just test-file`) reads state of
  another file.
- An install goes through `just sync-dependencies`, which uses the bun that
  `package.json` declares. The bun of the system (1.4) puts a second copy of
  the vendored `@lezer/markdown` into
  `node_modules/@codemirror/lang-markdown/node_modules`, and an install with
  the declared bun does not remove that copy. CodeMirror then has another
  `MarkdownParser` class than the app, the bundles hold one more copy of the
  parser, and `test/pandoc-lezer-fork-integration.spec.ts` fails. Move that
  folder to the trash and install again.
- The grammar oracle specs need the Pandoc release of
  `scripts/pandoc-reference.json`, not the Pandoc of the system. A local run
  gives its binary in `PANDOC_REFERENCE_BIN`; without it each oracle spec
  fails with "Pandoc grammar oracle mismatch". `scripts/setup-ci-toolchain.sh`
  has the download address and the checksum.
- The raw production command can report success without a fresh asar. Use `just
  package` or `just verify-build` so the verifier checks the current fingerprint.
- `userData/defaults` is copied once and never pruned. A surface that offers or
  runs an export reads `exportItems`; a list of its own lets a **stale shipped
  profile** replace an item of the application.
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

The local commit hook exempts this fork from verification. The hosted check `Unit Tests / Lint` passes when the jobs `unit` and `e2e` passed; each `e2e` shard builds the packaged app and runs its part of the assembled-app suite on it ([§13](docs/agents/e2e-runs.md)). Neither a clean commit nor a green local run is evidence about the PR; the run over the branch head is.

## When Acting on Review Feedback

A positive disposition requires a commit.

Do not resolve an accepted review comment until the code/proof remediation is committed and the reply cites the commit.

Reply “accepted,” “aligned,” “fixed,” “addressed,” or “will address” to a review thread only after the remediation is committed.
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
