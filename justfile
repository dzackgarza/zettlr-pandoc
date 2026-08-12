# Launch the MathJax-rendering fork spike.
bun := "bun"

# ai-review-ci contract consumed by doctor and the shared workflow triggers.
ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "develop"

# Show available recipes.
default:
    @just --list

[private]
sync-dependencies:
    {{bun}} install --frozen-lockfile

# Install the repo-owned Hyprland desktop launcher into ~/.local.
install-desktop-launcher:
    bash "{{justfile_directory()}}/scripts/install-desktop-launcher.sh"

# Launch the app in develop mode (webpack dev server + Electron).
# Free the dev ports first: a launch that was killed (or whose app was never
# quit) leaves a forge-start/Electron holding :9001, and the next launch dies
# on EADDRINUSE with the cause swallowed. --kill reaps only this project's
# stale dev processes.
launch: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py" --kill
    {{bun}} run start

# Launch the desktop app in develop mode with the normal user configuration.
# Extra arguments are file paths handed to Electron (electron-forge forwards
# app arguments after `--`). [positional-arguments] exposes them as "$@" so
# paths containing spaces survive; bare {{args}} interpolation would word-split.
[positional-arguments]
launch-desktop *files: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py" --kill
    "{{justfile_directory()}}/node_modules/.bin/electron-forge" start -- "$@"

# Build and verify a packaged Linux x64 app into out/Zettlr-Pandoc-linux-x64/.
# The verifier writes the source fingerprint only after it proves that a fresh
# app.asar contains the current commit.
package: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/verify-build.py"

# Run the packaged binary (build it first with `just package`).
run-packaged:
    ./out/Zettlr-Pandoc-linux-x64/zettlr-pandoc

# Run exactly one focused TypeScript test file without inheriting Mocha's
# repository-wide spec glob. Usage: just test-file test/example.spec.ts
test-file file: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 30000 "{{file}}"

# Run the focused workspace-reference test suite.
test-references: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 30000 "test/extract-references.spec.ts" "test/extract-references-subfigures.spec.ts" "test/resolve-references.spec.ts" "test/extract-references-pandoc-oracle.spec.ts" "test/fsal-reference-snapshots.spec.ts" "test/reference-index-overlay.spec.ts" "test/editor-reference-completion.spec.ts" "test/editor-reference-completion-help.spec.ts" "test/reference-fzf-search.spec.ts" "test/reference-search-project-ranking.spec.ts" "test/editor-reference-chips.spec.ts" "test/editor-reference-badges.spec.ts" "test/reference-hover.spec.ts" "test/reference-lint.spec.ts" "test/tab-manager-history.spec.ts" "test/compute-reference-edits.spec.ts" "test/rename-preview-summary.spec.ts" "test/reference-rename-atomicity.spec.ts" "test/show-toast-action.spec.ts" "test/navigation-shortcut-config.spec.ts" "test/project-reference-status.spec.ts" "test/editor-reference-completion-project-status.spec.ts" "test/reference-hover-project-status.spec.ts" "test/export-ordered-inputs.spec.ts" "test/export-quoted-inputs.spec.ts" "test/documents-provider-navigation.spec.ts" "test/preflight-crossref.spec.ts" "test/reference-create-label-confirm.spec.ts" "test/pandoc-quick-reference-lst.spec.ts" "test/pandoc-quick-help-search.spec.ts"

# Run the reference UI suite: the references-provider Electron shell spec
# (Phase 3b) plus the Chromium probe specs (Mod-P search overlay incl. the
# Phase 8 badge-keyed reverse lookup, Phase 5 navigation scenes, Phase 6
# create-label dialog + key-edit prompt, Phase 8 recoverable-error surface).
# Mirrors test-file's invocation with the longer timeout the xvfb probes need.
test-reference-ui: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 240000 "test/reference-provider-shell.spec.ts" "test/reference-search-overlay.spec.ts" "test/reference-navigation.spec.ts" "test/reference-create-label.spec.ts" "test/reference-rename-preview.spec.ts" "test/reference-error-surface.spec.ts"

# Cross-repository proof: ordered Project inputs through the companion
# pandoc-config compile-pandoc-project recipe (issue #1). Hard-bails when the
# companion checkout is missing; run explicitly, not part of the commit gate
# (it depends on a sibling checkout and a TeX toolchain run).
test-pandoc-config-integration:
    bash "{{justfile_directory()}}/scripts/test-pandoc-config-integration.sh"

# Real-toolchain proof for issue #26: drives the production flowmark service
# (source/app/util/flowmark-format.ts) with NO injected runner, so it runs the
# exact production `uvx … flowmark --inplace --semantic …` command string
# end-to-end against the real flowmark binary and asserts the semantic reflow.
# uvx fetches flowmark from git (network), so this is deliberately NOT a
# *.spec.ts file and is excluded from the default `just test` commit gate; run
# it explicitly. Fails loudly (typed flowmark-absent) if flowmark can't launch.
test-flowmark-integration: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 180000 "test/flowmark-format-integration.ts"

# Run the repository test suite. The guard executes before Mocha can start.
test: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --timeout 120000 --inline-diffs

# Run the assembled Electron app against its isolated document workspace.
# Portable: runs on hosted CI and locally alike.
test-e2e:
    {{bun}} install --frozen-lockfile
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    {{bun}} run test:e2e

# Run the workstation-owned desktop-launcher proofs (e2e/desktop/). These
# drive the installed desktop entry through a live Hyprland compositor and
# the packaged binary from `just package`; they assert those preconditions
# loudly instead of skipping, so they run in the local push gate, not CI.
test-e2e-desktop:
    {{bun}} install --frozen-lockfile
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    {{bun}} run test:e2e:desktop

# Git event hooks are installed globally by ai-review-ci via core.hooksPath
# (`pre-commit` -> this repo's test-commit, `pre-push` -> test-push).
# This repo owns only the delegated recipe contract, not hook installation.
[private]
test-commit:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

[private]
test-push:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push

[private]
test-ci:
    {{bun}} install --frozen-lockfile
    bash "{{justfile_directory()}}/scripts/configure-electron-sandbox-ci.sh"
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci

[private]
setup-ci:
    bash "{{justfile_directory()}}/scripts/setup-ci-toolchain.sh"

# Capture the real editor renderer in an isolated offscreen Electron process.
# This never starts Forge, a dev server, xdg-open, or the system browser.
# A fresh package-manager install leaves electron's chrome-sandbox without its
# root-owned SUID bits, which aborts Chromium under xvfb. The probe renders
# local test content only, so run unsandboxed rather than requiring sudo
# provisioning for the test suite.
capture-pandoc-divs output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" pandoc-divs "{{output}}"

# Capture the widget-indent scenes (issue #15) in isolated offscreen Electron:
# math widgets on visually indented list lines, plus the blockquote/div
# regression scenes. Writes screenshots and per-scene diagnostics JSON.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-widget-indent output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" widget-indent "{{output}}"

# Capture the TikZ editor scenes (issue #14) in isolated offscreen Electron:
# inline figures rendered by the REAL toolchain (pandoc + pdflatex + pdf2svg
# through the vendored filter), the in-place compile diagnostic, and the
# click-to-zoom lightbox reusing ImageViewer. Requires pdflatex and pdf2svg.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-tikz output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" tikz "{{output}}"

# Capture the real Pandoc quick-reference Vue component in isolated Electron.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-pandoc-help output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" pandoc-help "{{output}}"

# Capture the Mod-P reference search overlay in isolated Electron: bundles the
# probe entry with the production renderer webpack config, drives the real
# fixture-backed overlay, and writes screenshots plus the probe result JSON.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-reference-search output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-search "{{output}}"

# Capture the reference chip presentation in isolated offscreen Electron
# (issue #1 Phase 4). Follows the capture-pandoc-divs pattern; the entry and
# capture files land with the green implementation, and the recipe fails
# loudly until they exist. This never starts Forge, a dev server, xdg-open,
# or the system browser.
# A fresh package-manager install leaves electron's chrome-sandbox without its
# root-owned SUID bits, which aborts Chromium under xvfb. The probe renders
# local test content only, so run unsandboxed rather than requiring sudo
# provisioning for the test suite.
capture-reference-chips output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-chips "{{output}}"

# Capture the combined `@` completion popup in isolated offscreen Electron
# (issue #1, ledger C4): citation entries and typed label entries together,
# a label option's info panel with its quick-help link, and the disabled
# another-Project entry (whose inert apply the driver proves). Follows the
# capture-reference-chips esbuild pattern. This never starts Forge, a dev
# server, xdg-open, or the system browser.
capture-reference-completion output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-completion "{{output}}"

# Capture the reference hover tooltip presentation in isolated offscreen
# Electron (issue #1 Phase 4). Follows the capture-pandoc-divs pattern; the
# entry and capture files land with the green implementation, and the recipe
# fails loudly until they exist. This never starts Forge, a dev server,
# xdg-open, or the system browser.
# A fresh package-manager install leaves electron's chrome-sandbox without its
# root-owned SUID bits, which aborts Chromium under xvfb. The probe renders
# local test content only, so run unsandboxed rather than requiring sudo
# provisioning for the test suite.
capture-reference-hover output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-hover "{{output}}"

# Capture the Phase 5 reference navigation scenes (edit-first reveal, fold +
# scroll capture state, Mod-click states) in isolated offscreen Electron.
# Mirrors capture-pandoc-divs' esbuild bundling and the
# capture-reference-search Electron sandbox flags; the probe writes the same
# screenshots the test spec drives. This never starts Forge, a dev server,
# xdg-open, or the system browser.
capture-reference-navigation output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-navigation "{{output}}"

# Capture the REAL toolbar Back/Forward navigation controls (issue #1
# Phase 5; ledger C4) in enabled and disabled states: bundles the entry with
# the production renderer webpack config (real WindowToolbar + ButtonControl
# .vue components and the Clarity icon loader) and screenshots them in
# isolated offscreen Electron. This never starts Forge, a dev server,
# xdg-open, or the system browser.
capture-navigation-controls output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" navigation-controls "{{output}}"

# Capture the rename-preview dialog scenes (issue #1, review A4: the
# contract's "rename preview" capture) in isolated offscreen Electron:
# bundles the probe entry with the production renderer webpack config,
# mounts the dialog over the previewed fixture rename, and writes the
# preview/cancel/apply screenshots plus the probe result JSON. This never
# starts Forge, a dev server, xdg-open, or the system browser.
capture-rename-preview output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" rename-preview "{{output}}"

# Capture the issue #34 review-diff accept/reject interface in isolated
# offscreen Electron at desktop and narrow widths, light and dark.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-review-diff output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" review-diff "{{output}}"

# Run a real export headlessly (no GUI), via the app's own makeExport with the
# exact profile list the GUI sees (userData/defaults + custom profiles). Proves
# an export end-to-end from the terminal. Usage:
#   just export-headless PDF.yaml path/to/file.md
export-headless profile file: sync-dependencies
    node --require "{{justfile_directory()}}/scripts/harness/electron-stub.cjs" --import tsx "{{justfile_directory()}}/scripts/harness/export-run.ts" "{{profile}}" "{{file}}"

# Build observability: run the production package build and PROVE it produced a
# fresh app.asar built from the current commit. Exits non-zero (loud) if the
# build silently produced stale/no bytes -- the failure that shipped old code.
verify-build: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/verify-build.py"

# Verify the EXISTING packaged artifact is built from the current commit, without
# rebuilding. Fast staleness check.
verify-build-only:
    python3 "{{justfile_directory()}}/scripts/verify-build.py" --verify-only
