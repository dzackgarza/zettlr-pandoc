# TODO

## TikZ editing

### Absorb tikz-draw into the TikZ editing interface

Bring the visual-drawing functionality of
[keplerg/tikz-draw](https://github.com/keplerg/tikz-draw) (MIT) into the TikZ editing
interface (`source/win-main/Tikz*.vue`, `source/common/modules/markdown-editor/tikz-*.ts`):

- Direct-manipulation drawing tools: point, line, vector, circle, arc, rectangle, path,
  Bézier curve, label, image, grid.
- Select, move, and rotate tools; multi-select; copy and paste; arrow-key nudging.
- Snap to grid, pan, and zoom.
- Style controls: colors, line styles, thickness, arrow tips, fill patterns.
- Undo and redo.
- Round-trip with the TikZ source: a canvas edit updates the source text, and a source
  edit updates the canvas. tikz-draw only exports TikZ from its own JSON model, so
  parsing existing source back into the canvas (for example through the
  `@tikz-editor/lezer-tikz` parser) is new work.

### Modularize the TikZ editing experience

Try to extract the complete TikZ editing experience (source editor, live preview,
compiler diagnostics, Quiver integration, and the visual drawing tools above) into a
standalone module with no Zettlr dependency. The goal is that the module can, in
principle, run outside Zettlr, for example as a standalone replacement for
[QtikZ/KtikZ](https://github.com/fhackenberger/ktikz).

- Define the boundary: the host supplies the document text, a TeX compile service, and
  storage; the module owns editing, preview, and drawing.
- Move the Zettlr-specific wiring (IPC, config, Markdown code-block detection) behind
  that boundary.
- Show that the boundary works with a minimal standalone host that edits and previews a
  single `.tikz` file.
