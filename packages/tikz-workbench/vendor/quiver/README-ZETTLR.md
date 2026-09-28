# Zettlr Quiver vendor

This directory is a forked, vendored snapshot of `varkor/quiver` at the exact
commit recorded in `PROVENANCE.toml`. `ZETTLR.patch` is the complete Zettlr
delta against that upstream commit. `node scripts/update-quiver-vendor.mjs`
reconstructs `src/` from those two inputs and the separately pinned KaTeX
release.

The fork boundary is intentionally narrow:

- Quiver remains the owner of diagram layout, selection, history, undo/redo,
  touch/pointer interaction, arrow/vertex controls, TikZ-cd parsing and export.
- `zettlr-host.{html,css,mjs}` is a local iframe host. It exposes a small
  postMessage bridge for source, theme, macros, change events and Escape.
- Diagram changes are emitted from Quiver's own history/autosave mutation
  boundary. Zettlr does not infer edits from Quiver's DOM.
- KaTeX is loaded locally; the embedded editor has no dependency on the hosted
  q.uiver.app site.
- Zettlr owns persistence, theme, macro configuration and source editing.
  Quiver's URL Save/autosave/theme/About actions are not registered in host
  mode, and the web import/export/share panes are not exposed.
- Quiver's generated round-trip URL comment is removed before source is written
  back to Markdown; the Markdown `tikzcd` environment is the source of truth.

Macro consistency has an explicit boundary. The host receives the user's typed
MathJax macro map plus simple one-line declarations from the same maintained
TikZ template graph used by compilation. Definitions whose semantics cannot be
represented faithfully by KaTeX/Quiver are reported to the user instead of
being silently rewritten.
