#!/usr/bin/env bash
# Run Mocha with one temporary directory for the whole run.
#
# A spec makes its temporary files below os.tmpdir(), which reads TMPDIR at
# each call, and the processes that a spec starts inherit TMPDIR. This
# launcher gives the run one directory and removes it when the run ends. A
# spec that removes nothing leaves nothing behind.
#
# Usage: scripts/run-unit-tests.sh <mocha arguments>
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_temporary_directory="$(mktemp --directory --tmpdir zettlr-unit-tests-XXXXXX)"
trap 'rm -rf -- "$run_temporary_directory"' EXIT

TMPDIR="$run_temporary_directory" "$repository/node_modules/.bin/mocha" "$@"
