# Launch the MathJax-rendering fork spike.
# Yarn 4.11.0 is pinned via packageManager; route through the pinned CLI so a
# global Yarn 1 install can't shadow it.
yarn := "npx -y @yarnpkg/cli-dist@4.11.0"

# Show available recipes.
default:
    @just --list

# Launch the app in develop mode (webpack dev server + Electron).
launch:
    {{yarn}} start

# Build a packaged Linux x64 app into out/Zettlr-Pandoc-linux-x64/.
package:
    {{yarn}} package:linux-x64

# Run the packaged binary (build it first with `just package`).
run-packaged:
    ./out/Zettlr-Pandoc-linux-x64/zettlr-pandoc

# Run exactly one focused TypeScript test file without inheriting Mocha's
# repository-wide spec glob. Usage: just test-file test/example.spec.ts
test-file file:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 30000 "{{file}}"

# Run the focused workspace-reference test suite.
test-references:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 30000 "test/extract-references.spec.ts" "test/resolve-references.spec.ts" "test/extract-references-pandoc-oracle.spec.ts" "test/fsal-reference-snapshots.spec.ts" "test/reference-index-overlay.spec.ts" "test/editor-reference-completion.spec.ts" "test/reference-fzf-search.spec.ts" "test/editor-reference-chips.spec.ts" "test/editor-reference-badges.spec.ts" "test/reference-hover.spec.ts" "test/reference-lint.spec.ts" "test/tab-manager-history.spec.ts" "test/compute-reference-edits.spec.ts" "test/reference-rename-atomicity.spec.ts" "test/project-reference-status.spec.ts" "test/editor-reference-completion-project-status.spec.ts" "test/reference-hover-project-status.spec.ts" "test/export-ordered-inputs.spec.ts" "test/preflight-crossref.spec.ts" "test/live-buffer-reporter.spec.ts" "test/reference-create-label-confirm.spec.ts" "test/pandoc-quick-reference-lst.spec.ts" "test/pandoc-quick-help-references.spec.ts"

# Run the reference UI suite: the references-provider Electron shell spec
# (Phase 3b) plus the Chromium probe specs (Mod-P search overlay incl. the
# Phase 8 badge-keyed reverse lookup, Phase 5 navigation scenes, Phase 6
# create-label dialog + key-edit prompt, Phase 8 recoverable-error surface).
# Mirrors test-file's invocation with the longer timeout the xvfb probes need.
test-reference-ui:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 240000 "test/reference-provider-shell.spec.ts" "test/reference-search-overlay.spec.ts" "test/reference-navigation.spec.ts" "test/reference-create-label.spec.ts" "test/reference-error-surface.spec.ts"

# Cross-repository proof: ordered Project inputs through the companion
# pandoc-config compile-pandoc-project recipe (issue #1). Hard-bails when the
# companion checkout is missing; run explicitly, not part of the commit gate
# (it depends on a sibling checkout and a TeX toolchain run).
test-pandoc-config-integration:
    bash "{{justfile_directory()}}/scripts/test-pandoc-config-integration.sh"

# Run the repository test suite. The guard executes before Mocha can start.
test:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/mocha" --timeout 120000 --inline-diffs

[private]
test-commit: test

[private]
test-push: test

# Lint exactly one source file after the same development-server safety check.
lint-file file:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/node_modules/.bin/eslint" "{{file}}"

# Capture the real editor renderer in an isolated offscreen Electron process.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-pandoc-divs output:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    mkdir -p "{{output}}"
    "{{justfile_directory()}}/node_modules/.bin/esbuild" "{{justfile_directory()}}/test/editor-pandoc-div-visual-entry.ts" --bundle --platform=browser --format=iife --tsconfig="{{justfile_directory()}}/tsconfig.json" --outfile="{{output}}/pandoc-div-visual-bundle.js"
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" "{{justfile_directory()}}/test/editor-pandoc-div-visual-capture.cjs" "{{output}}"

# Capture the real Pandoc quick-reference Vue component in isolated Electron.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-pandoc-help output:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    mkdir -p "{{output}}"
    node "{{justfile_directory()}}/test/pandoc-quick-help-visual-build.cjs" "{{output}}"
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" --no-sandbox "{{justfile_directory()}}/test/pandoc-quick-help-visual-capture.cjs" "{{output}}"

# Capture the Mod-P reference search overlay in isolated Electron: bundles the
# probe entry with the production renderer webpack config, drives the real
# fixture-backed overlay, and writes screenshots plus the probe result JSON.
# This never starts Forge, a dev server, xdg-open, or the system browser.
capture-reference-search output:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    mkdir -p "{{output}}"
    node "{{justfile_directory()}}/test/reference-search-overlay-build.cjs" "{{output}}"
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" --ozone-platform=x11 --disable-gpu --no-sandbox "{{justfile_directory()}}/test/reference-search-overlay-probe.cjs" "{{output}}"

# Capture the reference chip presentation in isolated offscreen Electron
# (issue #1 Phase 4). Follows the capture-pandoc-divs pattern; the entry and
# capture files land with the green implementation, and the recipe fails
# loudly until they exist. This never starts Forge, a dev server, xdg-open,
# or the system browser.
capture-reference-chips output:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    test -f "{{justfile_directory()}}/test/editor-reference-chips-visual-entry.ts" || { echo "FATAL: test/editor-reference-chips-visual-entry.ts does not exist yet (Phase 4 green work)"; exit 1; }
    mkdir -p "{{output}}"
    "{{justfile_directory()}}/node_modules/.bin/esbuild" "{{justfile_directory()}}/test/editor-reference-chips-visual-entry.ts" --bundle --platform=browser --format=iife --tsconfig="{{justfile_directory()}}/tsconfig.json" --outfile="{{output}}/reference-chips-visual-bundle.js"
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" "{{justfile_directory()}}/test/editor-reference-chips-visual-capture.cjs" "{{output}}"

# Capture the reference hover tooltip presentation in isolated offscreen
# Electron (issue #1 Phase 4). Follows the capture-pandoc-divs pattern; the
# entry and capture files land with the green implementation, and the recipe
# fails loudly until they exist. This never starts Forge, a dev server,
# xdg-open, or the system browser.
capture-reference-hover output:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    test -f "{{justfile_directory()}}/test/reference-hover-visual-entry.ts" || { echo "FATAL: test/reference-hover-visual-entry.ts does not exist yet (Phase 4 green work)"; exit 1; }
    mkdir -p "{{output}}"
    "{{justfile_directory()}}/node_modules/.bin/esbuild" "{{justfile_directory()}}/test/reference-hover-visual-entry.ts" --bundle --platform=browser --format=iife --tsconfig="{{justfile_directory()}}/tsconfig.json" --outfile="{{output}}/reference-hover-visual-bundle.js"
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" "{{justfile_directory()}}/test/reference-hover-visual-capture.cjs" "{{output}}"

# Capture the Phase 5 reference navigation scenes (edit-first reveal, fold +
# scroll capture state, Mod-click states) in isolated offscreen Electron.
# Mirrors capture-pandoc-divs' esbuild bundling and the
# capture-reference-search Electron sandbox flags; the probe writes the same
# screenshots the test spec drives. This never starts Forge, a dev server,
# xdg-open, or the system browser.
capture-reference-navigation output:
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    mkdir -p "{{output}}"
    "{{justfile_directory()}}/node_modules/.bin/esbuild" "{{justfile_directory()}}/test/reference-navigation-entry.ts" --bundle --platform=browser --format=iife --define:process.platform='"linux"' --tsconfig="{{justfile_directory()}}/tsconfig.json" --outfile="{{output}}/reference-navigation-bundle.js"
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" --ozone-platform=x11 --disable-gpu --no-sandbox "{{justfile_directory()}}/test/reference-navigation-probe.cjs" "{{output}}"

# Run a real export headlessly (no GUI), via the app's own makeExport with the
# exact profile list the GUI sees (userData/defaults + custom profiles). Proves
# an export end-to-end from the terminal. Usage:
#   just export-headless PDF.yaml path/to/file.md
export-headless profile file:
    node --require "{{justfile_directory()}}/scripts/harness/electron-stub.cjs" --import tsx "{{justfile_directory()}}/scripts/harness/export-run.ts" "{{profile}}" "{{file}}"

# Build observability: run the production package build and PROVE it produced a
# fresh app.asar built from the current commit. Exits non-zero (loud) if the
# build silently produced stale/no bytes -- the failure that shipped old code.
verify-build:
    python3 "{{justfile_directory()}}/scripts/verify-build.py"

# Verify the EXISTING packaged artifact is built from the current commit, without
# rebuilding. Fast staleness check.
verify-build-only:
    python3 "{{justfile_directory()}}/scripts/verify-build.py" --verify-only
