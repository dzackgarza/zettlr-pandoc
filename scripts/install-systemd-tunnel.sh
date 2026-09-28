#!/usr/bin/env bash
# Install the repo-owned systemd user unit for the Zettlr-Pandoc OpenAI MCP tunnel.
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
unit_file_name="openai-tunnel-zettlr-pandoc.service"
unit_file="$service_dir/$unit_file_name"
services_dir="$HOME/.config/systemd/user"
installed_unit_file="$services_dir/$unit_file_name"
tunnel_client="$HOME/.local/bin/tunnel-client"

if [[ ! -f "$unit_file" ]]; then
  printf 'Required install source is unavailable: %s\n' "$unit_file" >&2
  exit 1
fi

case "$repo" in
  /tmp/*|/var/tmp/*|/dev/shm/*)
    printf 'Refusing to install a systemd unit from a temporary checkout: %s\n' "$repo" >&2
    printf 'Use the durable repository clone path.\n' >&2
    exit 1
    ;;
esac

if [[ ! -x "$tunnel_client" ]]; then
  printf 'tunnel-client is expected at %s for this unit file.\n' "$tunnel_client" >&2
  printf 'Install it from https://github.com/openai/tunnel-client/releases/latest.\n' >&2
  exit 1
fi

install -d "$services_dir"
ln -sfn "$unit_file" "$installed_unit_file"

if [[ $(readlink -f -- "$installed_unit_file") != "$unit_file" ]]; then
  printf 'Installed service symlink does not resolve to the repository source.\n' >&2
  exit 1
fi

printf 'Installed %s to %s\n' "$unit_file_name" "$installed_unit_file"
printf 'Run: just start-systemd-tunnel\n'
printf 'Verify: just status-systemd-tunnel\n'
