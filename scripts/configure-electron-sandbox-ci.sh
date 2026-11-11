#!/usr/bin/env bash
# Give the chrome-sandbox helper of one Electron distribution the owner and
# the mode that Chromium requires: root and 4755. Where the kernel refuses
# unprivileged user namespaces, as on the hosted Ubuntu runners, Chromium
# stops at start when the helper has another owner or mode. A copy of a
# distribution (the packaged app) has a helper of its own.
#
# Usage: configure-electron-sandbox-ci.sh <directory of the distribution>
set -euo pipefail

distribution="${1:?usage: configure-electron-sandbox-ci.sh <directory of the Electron distribution>}"
sandbox="$distribution/chrome-sandbox"

if [[ ! -f "$sandbox" ]]; then
  printf 'No chrome-sandbox helper in %s. The electron package downloads its distribution at the first require("electron").\n' "$distribution" >&2
  exit 1
fi
printf 'Electron sandbox: %s\n' "$sandbox"
sudo chown root:root "$sandbox"
sudo chmod 4755 "$sandbox"
test "$(stat -c %U:%G "$sandbox")" = root:root
test "$(stat -c %a "$sandbox")" = 4755
