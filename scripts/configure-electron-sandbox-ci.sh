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

test -f "$sandbox"
printf 'Electron sandbox: %s\n' "$sandbox"
sudo chown root:root "$sandbox"
sudo chmod 4755 "$sandbox"
test "$(stat -c %U:%G "$sandbox")" = root:root
test "$(stat -c %a "$sandbox")" = 4755
