#!/usr/bin/env bash
set -euo pipefail

node -e "require('electron')"
electron_binary=$(node -p "require('electron')")
sandbox="$(dirname "$electron_binary")/chrome-sandbox"

test -f "$sandbox"
printf 'Electron sandbox: %s\n' "$sandbox"
sudo chown root:root "$sandbox"
sudo chmod 4755 "$sandbox"
test "$(stat -c %U:%G "$sandbox")" = root:root
test "$(stat -c %a "$sandbox")" = 4755
