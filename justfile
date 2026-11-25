bun := "bun"

package_manager := `jq -r .packageManager package.json`
zettlr_agent_tunnel_service := "openai-tunnel-zettlr-pandoc.service"

ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "develop"

[doc("Show available recipes.")]
default:
    @just --list

[private]
sync-dependencies:
    {{bun}} x {{package_manager}} install --frozen-lockfile

[doc("Install the repo-owned Hyprland desktop launcher into ~/.local.")]
install-desktop-launcher:
    bash "{{justfile_directory()}}/scripts/install-desktop-launcher.sh"

[doc("Install the repo-owned systemd user service for the Agent API OpenAI MCP tunnel.")]
install-systemd-tunnel:
    bash "{{justfile_directory()}}/scripts/install-systemd-tunnel.sh"

[doc("Install the system unit that restarts the tunnel after resume (needs sudo).")]
install-systemd-tunnel-resume:
    sudo install -m 0644 "{{justfile_directory()}}/scripts/systemd/openai-tunnel-zettlr-pandoc-resume@.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable "openai-tunnel-zettlr-pandoc-resume@$(id -un).service"

[doc("Enable the Agent API tunnel service and start it from the installed unit.")]
start-systemd-tunnel:
    systemctl --user daemon-reload
    systemctl --user enable "{{zettlr_agent_tunnel_service}}"
    systemctl --user restart "{{zettlr_agent_tunnel_service}}"

[doc("Stop and disable the Agent API tunnel service.")]
stop-systemd-tunnel:
    systemctl --user disable --now "{{zettlr_agent_tunnel_service}}"

[doc("Inspect the tunnel service state.")]
status-systemd-tunnel:
    systemctl --user status "{{zettlr_agent_tunnel_service}}" --no-pager

[doc("Launch the app in develop mode (webpack dev server + Electron).")]
launch: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py" --kill
    {{bun}} run start

[doc("Launch the desktop app in develop mode with the normal user configuration.")]
[positional-arguments]
launch-desktop *files: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py" --kill
    "{{justfile_directory()}}/node_modules/.bin/electron-forge" start -- "$@"

[doc("Build and verify a packaged Linux x64 app into out/Zettlr-Pandoc-linux-x64/.")]
package: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/verify-build.py"

[doc("Bump the app version by level (patch, minor or major) and commit package.json.")]
bump level:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    git diff --quiet -- package.json || { echo "package.json has uncommitted changes" >&2; exit 1; }
    {{bun}} pm version "{{level}}" --no-git-tag-version
    version="$(jq -r .version package.json)"
    if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
        echo "Tag v$version already exists (upstream Zettlr owns it); choose another level" >&2
        exit 1
    fi
    git commit -m "chore(release): v$version" -- package.json

[doc("Tag the package.json version and push the tag; the Release workflow builds and publishes the AppImage.")]
release title:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    test -z "$(git status --porcelain)" || { echo "Working tree is not clean" >&2; exit 1; }
    version="$(jq -r .version package.json)"
    git tag -a "v$version" -m "{{title}}"
    git push origin "refs/tags/v$version"

[doc("Build the AppImage and its checksum list into release/ from a clean, verified")]
[private]
release-assets: package
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    test -z "$(git status --porcelain)" || { echo "Working tree is not clean" >&2; exit 1; }
    if [ -e release ]; then trash release; fi
    ./node_modules/.bin/electron-builder --linux AppImage --x64 --publish never --prepackaged out/Zettlr-Pandoc-linux-x64
    find release -mindepth 1 -maxdepth 1 ! -name '*.AppImage' -exec trash {} +
    (cd release && sha256sum -- *.AppImage > SHA256SUMS.txt)

[doc("Run the packaged binary (build it first with `just package`).")]
run-packaged:
    ./out/Zettlr-Pandoc-linux-x64/zettlr-pandoc

[doc("Run exactly one focused TypeScript test file without inheriting Mocha's")]
test-file file: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 30000 "{{file}}"

[doc("The unit-test launcher removes its temp directory at exit; an assembled-app")]
test-e2e-file file: _current-package
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    @{{e2e_lanes}} "{{file}}"

e2e_file_limit_seconds := "180"

e2e_lanes := 'exec setpriv --pdeathsig KILL just _e2e-run node --import tsx "' + justfile_directory() + '/e2e/support/run-lanes.ts" --file-limit-seconds ' + e2e_file_limit_seconds

[doc("An assembled-app spec starts the packaged build (`attach`), so a run")]
[private]
_current-package: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/verify-build.py" --if-stale

[doc("Run a command in the environment of an e2e run. The run owns its")]
[private]
[positional-arguments]
_e2e-run +command:
    #!/usr/bin/env bash
    set -euo pipefail
    setup='ip link set lo up && mount -t tmpfs -o mode=1777 e2e-x11 /tmp/.X11-unix'
    setup="$setup"' && exec unshare --map-user="$0" --map-group="$1" -- "${@:2}"'
    exec setpriv --pdeathsig KILL unshare --user --map-root-user --net --mount -- \
      bash -c "$setup" "$(id -u)" "$(id -g)" "$@"

[doc("Install or upgrade the flowmark and flowmark-lint commands from Flowmark's main branch.")]
install-flowmark:
    uv tool install --upgrade 'flowmark @ git+https://github.com/dzackgarza/pandoc-flowmark@main'

[doc("Run the focused workspace-reference test suite.")]
test-references: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 30000 "test/extract-references.spec.ts" "test/extract-references-subfigures.spec.ts" "test/resolve-references.spec.ts" "test/extract-references-pandoc-oracle.spec.ts" "test/fsal-reference-snapshots.spec.ts" "test/reference-index-overlay.spec.ts" "test/editor-reference-completion.spec.ts" "test/editor-reference-completion-help.spec.ts" "test/reference-fzf-search.spec.ts" "test/reference-search-project-ranking.spec.ts" "test/editor-reference-chips.spec.ts" "test/editor-reference-badges.spec.ts" "test/reference-hover.spec.ts" "test/tab-manager-history.spec.ts" "test/compute-reference-edits.spec.ts" "test/reference-rename-atomicity.spec.ts" "test/show-toast-action.spec.ts" "test/navigation-shortcut-config.spec.ts" "test/project-reference-status.spec.ts" "test/editor-reference-completion-project-status.spec.ts" "test/reference-hover-project-status.spec.ts" "test/export-ordered-inputs.spec.ts" "test/export-quoted-inputs.spec.ts" "test/documents-provider-navigation.spec.ts" "test/preflight-crossref.spec.ts" "test/reference-create-label-confirm.spec.ts" "test/pandoc-quick-reference-lst.spec.ts" "test/pandoc-quick-help-search.spec.ts"

[doc("Run the reference UI suite: the references-provider Electron shell spec")]
test-reference-ui: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 240000 "test/reference-provider-shell.spec.ts" "test/reference-search-overlay.spec.ts" "test/reference-navigation.spec.ts" "test/reference-create-label.spec.ts" "test/reference-error-surface.spec.ts"

[doc("Run the annotations panel animation performance and layout isolation spec.")]
test-annotations-animation: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 240000 "test/annotations-panel-animation.spec.ts"

[doc("Cross-repository proof: ordered Project inputs through the companion")]
test-pandoc-config-integration:
    bash "{{justfile_directory()}}/scripts/test-pandoc-config-integration.sh"

[doc("Run the format and lint services against the installed Flowmark commands.")]
test-flowmark-integration: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 180000 "test/flowmark-format-integration.ts"

[doc("Run the Zotero operations against the running Zotero, its local-write-api add-on and the Better BibTeX export.")]
test-zotero-integration: sync-dependencies
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --no-config --node-option import=tsx --require ./test/setup.js --extension ts --timeout 240000 "test/zotero-agent-api-integration.ts"

[doc("Run the repository test suite. The guard executes before Mocha can start.")]
test: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    "{{justfile_directory()}}/scripts/run-unit-tests.sh" --timeout 120000 --inline-diffs

[doc("Run the assembled Electron app against its isolated document workspace.")]
test-e2e shard="1/1": _current-package
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    @{{e2e_lanes}} --shard {{shard}} e2e/*.spec.ts

[doc("Run the workstation-owned desktop-launcher proofs (e2e/desktop/). These")]
test-e2e-desktop: _current-package
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    {{bun}} run test:e2e:desktop

[doc("Git event hooks are installed globally by ai-review-ci via core.hooksPath")]
[private]
test-commit:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

[doc("The desktop proofs hang off THIS recipe rather than scripts[\"test:push\"]:")]
[private]
test-push:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push
    @just test-e2e-desktop

[private]
test-ci:
    {{bun}} x {{package_manager}} install --frozen-lockfile
    node -e "require('electron')"
    bash "{{justfile_directory()}}/scripts/configure-electron-sandbox-ci.sh" "{{justfile_directory()}}/node_modules/electron/dist"
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci

[doc("The scheduled QC run dispatches this tier: the whole-tree debt audit.")]
[private]
ambient:
    {{bun}} x {{package_manager}} install --frozen-lockfile
    @just -f ~/ai-review-ci/justfiles/bun.just -d . ambient

[private]
setup-ci:
    just --justfile "{{justfile_directory()}}/justfile" install-flowmark
    bash "{{justfile_directory()}}/scripts/setup-ci-toolchain.sh"

[doc("Capture the real editor renderer in an isolated offscreen Electron process.")]
capture-pandoc-divs output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" pandoc-divs "{{output}}"

[doc("Capture rendered YAML front matter in the production CodeMirror editor.")]
capture-yaml-frontmatter output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" yaml-frontmatter "{{output}}"

[doc("Capture the widget-indent scenes (issue #15) in isolated offscreen Electron:")]
capture-widget-indent output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" widget-indent "{{output}}"

[doc("Capture the TikZ editor scenes (issue #14) in isolated offscreen Electron:")]
capture-tikz output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" tikz "{{output}}"

[doc("Capture and assemble the README demo GIFs (math typing, theorem envs,")]
readme-demos output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" readme-demos "{{output}}"
    bash "{{justfile_directory()}}/scripts/build-readme-demos.sh" "{{output}}"

[doc("Capture the real Pandoc quick-reference Vue component in isolated Electron.")]
capture-pandoc-help output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" pandoc-help "{{output}}"

[doc("Capture the Mod-P reference search overlay in isolated Electron: bundles the")]
capture-reference-search output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-search "{{output}}"

[doc("Capture the reference chip presentation in isolated offscreen Electron")]
capture-reference-chips output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-chips "{{output}}"

[doc("Capture the combined `@` completion popup in isolated offscreen Electron")]
capture-reference-completion output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-completion "{{output}}"

[doc("Capture the reference hover tooltip presentation in isolated offscreen")]
capture-reference-hover output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-hover "{{output}}"

[doc("Capture the Phase 5 reference navigation scenes (edit-first reveal, fold +")]
capture-reference-navigation output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" reference-navigation "{{output}}"

[doc("Capture the issue #34 review-diff accept/reject interface in isolated")]
capture-review-diff output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" review-diff "{{output}}"

[doc("Capture M5's four structural-gate scenes (doc-collaboration plan, section")]
capture-editor-annotations output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" editor-annotations "{{output}}"

[doc("Capture the M6 selection-creation composer (plan scene")]
capture-selection-composer output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" selection-composer "{{output}}"

[doc("The collaboration scenes of the plan's capture suite, in the current")]
capture-annotations-panel output: sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" annotations-panel "{{output}}"

[doc("M10's gate: assembles the plan's full twelve-scene capture suite (section")]
capture-annotations output="/tmp/zettlr-pandoc-annotations-captures": sync-dependencies
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" editor-annotations "{{output}}"
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" selection-composer "{{output}}"
    {{bun}} run "{{justfile_directory()}}/scripts/capture-runner.mjs" annotations-panel "{{output}}"
    @echo "Twelve-scene capture suite written to {{output}}"

[doc("Capture the real main-window chrome: the assembled app launched through the")]
capture-chrome output="/tmp/zettlr-pandoc-chrome-captures" launch_timeout_ms="180000": _current-package
    python3 "{{justfile_directory()}}/scripts/assert-dev-server-stopped.py"
    xvfb-run -a --server-args="-screen 0 1920x1080x24" node --import tsx "{{justfile_directory()}}/scripts/chrome-capture.ts" "{{output}}" "{{launch_timeout_ms}}"

[doc("Run a real export headlessly (no GUI), via the app's own makeExport with the")]
export-headless profile file: sync-dependencies
    node --require "{{justfile_directory()}}/scripts/harness/electron-stub.cjs" --import tsx "{{justfile_directory()}}/scripts/harness/export-run.ts" "{{profile}}" "{{file}}"

[doc("Build observability: run the production package build and PROVE it produced a")]
verify-build: sync-dependencies
    python3 "{{justfile_directory()}}/scripts/verify-build.py"

[doc("Verify the EXISTING packaged artifact is built from the current commit, without")]
verify-build-only:
    python3 "{{justfile_directory()}}/scripts/verify-build.py" --verify-only
