# TikZ render

Compiles one TikZ or tikzcd diagram to an SVG figure and shows the figure. The
package holds no diagram editor: the graphical editor is the separate
application [Visual TikZ Editor](https://github.com/dzackgarza/visual-tikz-editor),
which Zettlr starts on a diagram.

The package imports nothing from the application. Import a module by its path:

```ts
import { renderTikz } from "@dzack/tikz-render/tikz-render";
import TikzPreviewPane from "@dzack/tikz-render/ui/TikzPreviewPane.vue";
```

| Module                                                  | Content                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tikz-render`                                           | `renderTikz`: the TeX compilation against the `dzg-tikz` template of `~/.pandoc`, the figure cache, and the template and data directory lookups. Node only.        |
| `compiler-log`                                          | The TeX log lines that a failed compilation reports.                                                                                                               |
| `mathjax-config`                                        | `mathJaxPackages`, the TeX packages of each renderer; `parseMathJaxMacros` and `parseMathJaxPairedDelimiters`, the formats of the central projections. A malformed entry throws. |
| `tex-command-declarations`                              | The commands that a TeX source declares.                                                                                                                           |
| `source-block`                                          | `TikzSourceBlock`: one diagram of a document, with its language and source range; `tikzBlockHasContiguousSource` says if that source is one range of the document. |
| `live-preview`                                          | `TikzLivePreviewController`: the state of a preview, which request is current, and which figure it shows.                                                          |
| `host`                                                  | `TikzPreviewHost`: what the preview needs from its application.                                                                                                    |
| `ui/TikzPreviewPane.vue`                                | The preview pane: figure, compiler status, rebuild, fullscreen. The `actions` slot takes controls of the application.                                              |
| `ui/TikzCompilerPreview.vue`, `ui/TikzFigureViewer.vue` | The parts of the pane.                                                                                                                                             |

`renderTikz` takes a `TikzRenderConfig` and a priority. The renders of a
process run one at a time; a `preview` render goes before the `background`
renders that wait. Its `timeoutMs` is the time that one render may take. A render that takes longer is stopped with each process that
it started, and the result is `render-timeout`. A render that ends leaves no
process and no file in the temporary directory.

## The filter and the template

- **One filter.** `renderTikz` runs `filters/tikzcd.lua` of a Pandoc data
  directory through pandoc. `resolveTikzDataDir` takes the configured
  directory when the setting names one, else `~/.pandoc`; without a filter
  there it throws, and no copy of the package takes its place. The filter
  loads no other Lua file, so the directory needs only that file.
- **The protocol line.** The first line of the filter is
  `local ZETTLR_TIKZ_RENDER_PROTOCOL = <n>` (the contract of
  `dzackgarza/pandoc-config`, section "The `tikzcd.lua` filter contract" of
  its `AGENTS.md`). `tikzRenderProtocolVersion` reads the number from that
  line only. A filter whose number is not `TIKZ_RENDER_PROTOCOL` is refused
  by `resolveTikzDataDir` and by the start preflight. Raise both numbers
  when the application needs a behaviour of the filter that an older
  filter does not have.
- **The template is not part of the data directory.**
  `resolveTikzTemplatePath` gives `~/.pandoc/templates/standalone-tikz.tex`
  for each data directory, so a configured filter is never a second owner
  of the preamble. The package makes no preamble and adds no macros.
- **The cache key holds the template graph.** `tikzTemplateDependencyHash`
  hashes each file that the template reaches through `\usepackage`,
  `\input` and `\include` under `~/.pandoc`, by its path relative to
  `~/.pandoc` and its bytes, in sorted order. A TeX package of the system is
  outside the graph. The hash is computed again for each render, because the
  macro files can change while the application runs.
- **The request.** `docPath` is the document of the figure; the empty
  string is a buffer without a file, and the filter then resolves `\input`
  from the working directory. `TikzRenderConfig.env` is the environment of
  each process of the render; the package reads no environment of its own.
- **The results.** A tool that is not on the `PATH` is `missing-tools`; a
  tool that fails its probe for another cause is `toolchain-probe-failed`
  with that cause, and the other tools are not probed. A render that a
  signal ends is `render-terminated` with the signal, and one that passes
  `timeoutMs` is `render-timeout`. A figure that the filter left out of
  the HTML is a `compile-error`. The path of the lightbox SVG holds a hash
  of the SVG, so a figure that a rebuild changed reaches a viewer that
  shows the old one.
- **Scratch directories.** Each render has a temporary directory of its
  own, which the render removes. At the exit of the application the package
  removes each directory of a render that did not end; the exit listener of
  `@dzack/external-process` runs before it and stops the processes.

## Tests

The compile cases run the real toolchain with the filter of
`test/fixtures/tikz-data` (a pdflatex fork of the filter of
`pandoc-config`; its `PROVENANCE.toml` names the changes). On a machine
without pdflatex and pdf2svg the same cases expect `missing-tools`.

The application supplies a `TikzPreviewHost`: `render` runs `renderTikz` (in
Zettlr, through IPC in the main process), `figureUrl` gives the URL of a
rendered figure, and `reportError` takes an error for the application log.

Run the tests of the package with `just test-file packages/tikz-render/test/<file>`.
