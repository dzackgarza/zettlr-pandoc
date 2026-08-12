#!/usr/bin/env bash
# Install the repo-owned systemd user unit for the Zettlr-Pandoc tunnel.
set -euo pipefail

: "${HOME:?HOME must be set}"

for required_command in dirname install ln readlink; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$required_command" >&2
    exit 1
  fi
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/.." && pwd -P)
service_dir="$repo/scripts/systemd"
unit_file_name="cloudflared-zettlr-pandoc.service"
unit_file="$service_dir/$unit_file_name"
services_dir="$HOME/.config/systemd/user"
installed_unit_file="$services_dir/$unit_file_name"
config_file="$HOME/.cloudflared/zettlr-pandoc-laptop.yml"

for required_file in "$unit_file"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Required install source is unavailable: %s\n' "$required_file" >&2
    exit 1
  fi
done

case "$repo" in
  /tmp/*|/var/tmp/*|/dev/shm/*)
    printf 'Refusing to install a systemd unit from a temporary checkout: %s\n' "$repo" >&2
    printf 'Use the durable repository clone path.\n' >&2
    exit 1
    ;;
esac

if [[ ! -x /bin/cloudflared ]]; then
  printf 'cloudflared is expected at /bin/cloudflared for this unit file.\n' >&2
  printf 'Install cloudflared or edit the unit to point to the correct binary path.\n' >&2
fi

install -d "$services_dir"
ln -sfn "$unit_file" "$installed_unit_file"

if [[ $(readlink -f -- "$installed_unit_file") != "$unit_file" ]]; then
  printf 'Installed service symlink does not resolve to the repository source.\n' >&2
  exit 1
fi

if [[ ! -f "$config_file" ]]; then
  printf 'Cloudflared config file is missing: %s\n' "$config_file" >&2
  printf 'Create it from your Cloudflare tunnel credentials before enabling this service.\n'
fi

printf 'Installed %s to %s\n' "$unit_file_name" "$installed_unit_file"
printf 'Run: just start-systemd-tunnel\n'
printf 'Verify: just status-systemd-tunnel\n'
