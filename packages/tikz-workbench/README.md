# TikZ workbench

The TikZ workbench edits one TikZ figure. It shows three modes of the same source:

- **Compiled preview**: the figure as TeX compiles it, with the complete compiler diagnostics.
- **Visual editor**: the pinned fork of [DominikPeters/tikz-editor](https://github.com/DominikPeters/tikz-editor) for `tikzpicture` figures.
- **Quiver editor**: the pinned fork of [varkor/quiver](https://github.com/varkor/quiver) for `tikzcd` diagrams.

The package imports no Zettlr code. Zettlr and the standalone server are two hosts of the same component, `src/ui/TikzWorkbench.vue`.

## Host contract

A host mounts `TikzWorkbench` with three props:

| Prop | Contract |
| --- | --- |
| `target` | The figure: its source bytes, their range in the host document, `kind`, `language` and `docPath` (`src/live-preview.ts`). |
| `host` | The services of `TikzWorkbenchHost` (`src/host.ts`), listed below. |
| `theme` | `"light"` or `"dark"`. |

| `TikzWorkbenchHost` member | Contract |
| --- | --- |
| `readSource(from, to)` | Return the bytes that the host document stores in the range. |
| `writeSource(from, to, insert)` | Replace the range. The host then passes a new `target`. |
| `render(request)` | Compile the source and return the typed result of `renderTikz` (`src/tikz-render.ts`). |
| `quiverMacros()` | Return the macro projection for Quiver (`src/quiver-macros.ts`). |
| `figureUrl(figure)` | Return the URL from which the preview loads a compiled figure. |
| `imageBaseUrl(docPath)` | Return the URL against which the visual editor resolves image paths. |
| `editorUrl`, `quiverUrl` | The pages `vendor/tikz-editor/src/index.html` and `vendor/quiver/src/zettlr-host.html`, as the host serves them. |
| `reportError(message, error)` | Show or log an error. |

The host document is the source authority. The editors write through `writeSource` only when `readSource` still returns the bytes they loaded, so a stale editor message cannot overwrite a newer edit.

`src/tikz-render.ts` runs in Node. It compiles through the shared Pandoc data tree `~/.pandoc` (the TikZ filter and `templates/standalone-tikz.tex`) with `pandoc`, `pdflatex` and `pdf2svg`.

## Standalone workbench

```sh
just tikz-standalone path/to/figure.tikz
```

`standalone/server.ts` builds the page with Vite and serves one `.tikz` or `.tikzcd` file on 127.0.0.1. The page has a source pane and the workbench. **Save** (or Ctrl+S) writes the file only if the file did not change on disk after the page loaded it. Image paths in the source resolve against the directory of the file.

## Vendored editors

`vendor/tikz-editor` and `vendor/quiver` are reconstructed from their pinned upstream commits and patches:

```sh
just update-tikz-editor-vendor
just update-quiver-vendor
```

Each `PROVENANCE.toml` records the upstream commit.

## Tests

`test/` holds the package tests, which the repository's mocha configuration runs. `test/fixtures/tikz-data` is a test-only copy of the shared Pandoc TikZ filter and template.
