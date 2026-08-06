#!/usr/bin/env bash
# Install the repo-owned development launcher and desktop entry under ~/.local.
set -euo pipefail

: "${HOME:?HOME must be set}"

for required_command in dirname grep install ln mktemp readlink rm sed; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$required_command" >&2
    exit 1
  fi
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/.." && pwd -P)

# The bin entries are installed as symlinks into this checkout so the dev
# launcher tracks repo edits. A temporary checkout therefore poisons the
# machine-global launcher with links that dangle when the directory is
# cleaned up (observed 2026-08-06: ~/.local/bin/zettlr-pandoc-dev pointing
# into a vanished /tmp integration tree). Refuse the non-durable source.
case "$repo" in
  /tmp/*|/var/tmp/*|/dev/shm/*)
    printf 'Refusing to install launcher symlinks from a temporary checkout: %s\n' "$repo" >&2
    printf 'Run this from the durable repository clone.\n' >&2
    exit 1
    ;;
esac

source_dir="$repo/scripts/desktop"
bin_dir="$HOME/.local/bin"
applications_dir="$HOME/.local/share/applications"
icons_dir="$HOME/.local/share/icons/hicolor/512x512/apps"
desktop_template="$source_dir/zettlr-pandoc.desktop.in"
desktop_file="$applications_dir/zettlr-pandoc.desktop"
icon_source="$repo/resources/icons/png/512x512.png"
icon_file="$icons_dir/zettlr-pandoc.png"

for source_file in \
  "$source_dir/zettlr-pandoc-boot" \
  "$source_dir/zettlr-pandoc-dev" \
  "$desktop_template" \
  "$icon_source"; do
  if [[ ! -f "$source_file" ]]; then
    printf 'Required launcher source is unavailable: %s\n' "$source_file" >&2
    exit 1
  fi
done

install -d "$bin_dir" "$applications_dir" "$icons_dir"
ln -sfn "$source_dir/zettlr-pandoc-boot" "$bin_dir/zettlr-pandoc-boot"
ln -sfn "$source_dir/zettlr-pandoc-dev" "$bin_dir/zettlr-pandoc-dev"
install -m 0644 "$icon_source" "$icon_file"

desktop_tmp=$(mktemp)
cleanup() {
  rm -f "$desktop_tmp"
}
trap cleanup EXIT

sed "s|@HOME@|$HOME|g" "$desktop_template" >"$desktop_tmp"
install -m 0644 "$desktop_tmp" "$desktop_file"

if [[ $(readlink -f -- "$bin_dir/zettlr-pandoc-boot") != "$source_dir/zettlr-pandoc-boot" ]] ||
  [[ $(readlink -f -- "$bin_dir/zettlr-pandoc-dev") != "$source_dir/zettlr-pandoc-dev" ]]; then
  printf 'Installed launcher symlinks do not resolve to the repository sources.\n' >&2
  exit 1
fi

grep -Fqx "Exec=$bin_dir/zettlr-pandoc-dev %F" "$desktop_file"
grep -Fqx 'Icon=zettlr-pandoc' "$desktop_file"

printf 'Installed Zettlr-Pandoc desktop launcher from %s\n' "$repo"
