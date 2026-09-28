# Zettlr TikZ editor vendor

This directory embeds a pinned fork/build of `DominikPeters/tikz-editor` at the exact commit in `PROVENANCE.toml`. The upstream editor remains the owner of TikZ parsing, semantic evaluation, canvas rendering, edit capabilities, source patches, history, selection, and direct manipulation.
Zettlr does not maintain a parallel TikZ semantic subset.

`embed/` provides the iframe-oriented platform adapter and postMessage bridge.
`ZETTLR.patch` is the deliberately small upstream-source delta: it redirects MathJax's browser component loader to checked-in local assets, limits the font picker to the locally shipped New Computer Modern runtime, and hides the auxiliary CDN-backed TikZJax compiled-picture command in the web/embed target.
It does not replace or fork the upstream parser, semantic model, scene graph, or editing machinery.
`src/` is checked-in generated static output, so ordinary Zettlr builds never need network access or an npm install inside the vendored project.

`node scripts/update-tikz-editor-vendor.mjs` reconstructs `src/` from the pinned upstream commit plus `ZETTLR.patch` and `embed/`. The generated output also contains the exact MathJax 4.1.1 browser component package selected by upstream's lockfile and the matching NewCM SVG font component tree.
No editor/runtime JavaScript is fetched from a CDN when Zettlr runs.

The host contract is intentionally source-authoritative:

- Zettlr sends the exact active `tikzpicture` source on load and after any manual CodeMirror edit.

- The embedded editor sends its complete current source after its own edit action.

- Zettlr accepts an iframe edit only if CodeMirror still contains the exact bytes from which that edit was derived; newer CodeMirror bytes always win.

- Zettlr owns fullscreen geometry.
  The embed receives fullscreen state and exposes both an in-editor exit control and Escape-to-exit while iframe focus is active.

- Unsupported or partially supported TikZ is therefore never stripped merely because Zettlr does not understand it.
  Upstream `tikz-editor` decides which visual edit actions are sound for the source it parsed.

The bridge shape follows the independently developed TeXlyre tikz-editor embed pattern, but this vendor is rebuilt directly from DominikPeters/tikz-editor and has no runtime dependency on TeXlyre.
