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
    xvfb-run -a "{{justfile_directory()}}/node_modules/.bin/electron" "{{justfile_directory()}}/test/pandoc-quick-help-visual-capture.cjs" "{{output}}"

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
