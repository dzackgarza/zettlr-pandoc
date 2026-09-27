# TikZ workbench

This module owns TikZ compilation, Quiver macro projection, the source-aware visual editor, and the standalone workbench page. It imports no Zettlr code. The Zettlr adapters in `source/app/util` re-export the compiler and macro utilities; the Markdown preview components supply the active source block and IPC services.

The workbench page reads `globalThis.tikzWorkbenchHost` from `/host.js`. A host supplies:

| Member | Contract |
| --- | --- |
| `editorUrl`, `quiverUrl` | URLs for the pinned editor and Quiver iframe assets. |
| `imageBaseUrl` | URL of the document's image directory. |
| `load()` | Return `{ source, revision }` for one `.tikz` file. |
| `compile(source)` | Return the typed TikZ render result, including compiler diagnostics. |
| `save(source, revision)` | Store the source if the revision is current; return the new revision. |
| `quiverMacros()` | Return the central macro projection for Quiver. |

`scripts/tikz-standalone-host.js` implements this contract for one local file. Run `just tikz-standalone path/to/file.tikz` to open it. Image paths in TikZ source are relative to that file. The host serves images from the file's directory and rejects paths outside it.

The visual editor is reconstructed from its pinned upstream source and `vendor/tikz-editor/ZETTLR.patch` with `just update-tikz-editor-vendor`.
