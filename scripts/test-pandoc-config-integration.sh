#!/usr/bin/env bash
# Cross-repository proof for issue #1: ordered Project inputs flow through the
# companion pandoc-config compile-pandoc-project recipe and produce natively
# labeled/linked LaTeX, driven from this repository's reference-workspace
# fixture. Guarded: hard-bails when the companion checkout is absent.
#
# PROFILE COVERAGE (issue #5, C9): one export profile IS the entire recipe
# surface. The recipe exporter is reachable only through the single custom
# 'PDF.yaml' profile (writer 'compile-pandoc' — see getCustomProfiles() and
# the makeExport dispatch in source/.../exporter/index.ts); every other
# profile routes through the ordinary Pandoc-defaults, textbundle, or script
# exporters, which never touch the ~/.pandoc justfile boundary this harness
# proves. Within that one profile, BOTH recipes are argv-proven by
# test/export-ordered-inputs.spec.ts / export-quoted-inputs.spec.ts
# (compile-pandoc single-file and compile-pandoc-project), and this script
# proves the Project recipe end-to-end against the real companion.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PANDOC_CONFIG_DIR="${PANDOC_CONFIG_DIR:-$HOME/gitclones/pandoc-config}"
COMPANION_JUSTFILE="$PANDOC_CONFIG_DIR/justfile"

if [ ! -f "$COMPANION_JUSTFILE" ]; then
  echo "❌ test-pandoc-config-integration: companion checkout not found at $PANDOC_CONFIG_DIR" >&2
  echo "   Set PANDOC_CONFIG_DIR to a pandoc-config checkout on the feat/ordered-project-inputs branch." >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/zettlr-pandoc-config-proof-XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

cp "$REPO_ROOT/test/fixtures/reference-workspace/ProjectA/Theorems.md" "$WORKDIR/"
cp "$REPO_ROOT/test/fixtures/reference-workspace/ProjectA/Coble_Lattice_Table.md" "$WORKDIR/"
cp "$REPO_ROOT/test/fixtures/reference-workspace/ProjectA/Halphen_Surfaces.md" "$WORKDIR/"

cd "$WORKDIR"
just --justfile "$COMPANION_JUSTFILE" compile-pandoc-project proof research_draft.tex Theorems.md Coble_Lattice_Table.md Halphen_Surfaces.md

TEX="$WORKDIR/.build_pandoc/output.tex"
fail() { echo "❌ $1" >&2; exit 1; }
[ -f "$TEX" ] || fail "intermediate .tex missing at $TEX"

# Theorem-div explicit id -> native label; the authored cluster in
# Halphen_Surfaces.md ([@thm:torelli; @lem:embedding]) -> one \cref cluster
# (lem:embedding is the fixture's intentional workspace-missing key).
grep -qF '\label{thm:torelli}' "$TEX" || fail 'explicit theorem-div id did not emit \label{thm:torelli}'
grep -qF '\cref{thm:torelli,lem:embedding}' "$TEX" || fail 'cluster [@thm:torelli; @lem:embedding] did not become \cref{thm:torelli,lem:embedding}'
grep -qF '\cref{tbl:coble-lattices}' "$TEX" || fail '@tbl:coble-lattices did not become \cref{tbl:coble-lattices} (crossref inactive?)'
grep -qF '\begin{theorem}' "$TEX" || fail 'theorem environment missing'
# The strong citeproc form, matching the companion's own assertion
# (tests/test-project-references.sh): the authored [@Ols04, Lem. 7.1] must
# survive as a real biblatex \autocite with its locator, not merely as the
# key appearing somewhere in the output.
grep -qF '\autocite[Lem. 7.1]{Ols04}' "$TEX" || fail 'authored [@Ols04, Lem. 7.1] did not render as \autocite[Lem. 7.1]{Ols04} (citeproc/biblatex passthrough broken?)'
grep -qF '{thm:should-not-index}' "$TEX" && fail 'proof-div id leaked into a label or reference' || true

# Ordered inputs: file 1 content before file 2 content before file 3 content.
# Markers are unique body prose (headings are out — --toc duplicates them
# early), matched against a newline-flattened copy so TeX line wrapping
# cannot split a marker.
FLAT="$(tr '\n' ' ' < "$TEX")"
position_of() {
  local prefix="${FLAT%%"$1"*}"
  if [ "$prefix" = "$FLAT" ]; then echo ""; else echo "${#prefix}"; fi
}
POS1="$(position_of 'points agree in the quotient')"
POS2="$(position_of 'tenth infinitely near blowup')"
POS3="$(position_of 'pencil of plane sextics')"
[ -n "$POS1" ] && [ -n "$POS2" ] && [ -n "$POS3" ] && [ "$POS1" -lt "$POS2" ] && [ "$POS2" -lt "$POS3" ] \
  || fail "input order not preserved (Theorems@${POS1:-none}, Coble@${POS2:-none}, Halphen@${POS3:-none})"

echo "✅ test-pandoc-config-integration: ordered inputs, native labels/refs, and citation passthrough proven against $PANDOC_CONFIG_DIR"
