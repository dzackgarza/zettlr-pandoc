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

# Build a packaged Linux x64 app into out/Zettlr-linux-x64/.
package:
    {{yarn}} package:linux-x64

# Run the packaged binary (build it first with `just package`).
run-packaged:
    ./out/Zettlr-linux-x64/Zettlr

# Refresh the vendored MathJax macro snapshot from ~/.pandoc.
# The generator (bin/generate-mathjax-config.py) lives upstream in
# github.com/dzackgarza/pandoc-config; this copies its current output.
sync-mathjax-macros:
    cp ~/.pandoc/templates/css/mathjax-macros.ts source/common/util/mathjax-macros.generated.ts
    @echo "Synced $(wc -l < source/common/util/mathjax-macros.generated.ts) lines from ~/.pandoc"
