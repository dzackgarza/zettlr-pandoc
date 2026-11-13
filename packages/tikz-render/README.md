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
| `mathjax-config`                                        | `parseMathJaxMacros`: the format of the central MathJax macro projection.                                                                                          |
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

The application supplies a `TikzPreviewHost`: `render` runs `renderTikz` (in
Zettlr, through IPC in the main process), `figureUrl` gives the URL of a
rendered figure, and `reportError` takes an error for the application log.

Run the tests of the package with `just test-file packages/tikz-render/test/<file>`.
