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

# Link a MathJax macro export (any tex.macros-format JSON) into the config dir
# so the app loads it. Defaults to the pandoc macro export. `just launch` uses
# the dev data dir; a packaged install reads ~/.config/Zettlr/mathjax-macros.json.
link-macros source="$HOME/.pandoc/templates/css/mathjax-macros.json":
    mkdir -p resources/test-cfg
    ln -sf "{{source}}" resources/test-cfg/mathjax-macros.json
    @echo "Linked {{source}} -> resources/test-cfg/mathjax-macros.json"
