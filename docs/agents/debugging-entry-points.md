# Debugging entry points

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
  bibliography file paths (`document-bibliographies.ts`: the files that the
  linted text names, by the rules of citeproc; the Project comes from the folder
  of the document, so an open document whose file was removed keeps it),
  compiler findings) and must not own any rule decision or run
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
  queue, the startup Flowmark update and the index of the workspaces after a
  change of the open paths each register a long-running task
  (`LongRunningTaskProvider`). The status bar names the newest running task
  with its elapsed time; its indicator opens the task list. The status bar
  has the indicator only while the list holds a task, and a window has a
  limit of active WebGL contexts: an indicator that leaves gives its context
  back (`IrisIndicator.dispose`, the extension `WEBGL_lose_context`). Proof:
  `e2e/task-indicator-webgl-context.spec.ts`. A routine task
  ends through `settleTask`: a success leaves the list, a failure stays
  listed with its error. Each path out of the work, a rejection too, ends
  its task. New background work registers a task the same way. A file that
  goes away between the list of the index and its read is not a failure
  (`test/fsal-reindex.spec.ts`).
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
- **TeX command completion offers what `tex/unknown-command` accepts.** The
  command `tex-command-vocabulary` (`DocumentLintProvider.texCommandVocabulary`,
  `util/flowmark-tex-vocabulary.ts`) runs `flowmark-lint --tex-vocabulary`
  with the `tex` context of the lint. It answers Flowmark's TeXstudio index
  and the packages that the context loads (the host packages and the packages
  of the central macro tree). The completion (`autocomplete/tex.ts`) adds the
  packages that the TeX of the document loads, by Flowmark's rule
  (`collectTexContext`), and offers the commands of their closure. The app
  holds no copy of the index. A window asks one time: a Flowmark update or a
  change of the packages of the macro tree reaches the next window. Proof:
  `test/texstudio-command-index.spec.ts` (the lint and the completion agree),
  `e2e/autocomplete-language-sources.spec.ts` (the window asks the command).
- The project's own source code is checked by the global ai-review-ci bun
  profile (`just test-commit`, `just test-ci`), not by a repo-local linter.
