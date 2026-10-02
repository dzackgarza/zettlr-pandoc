/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Zettlr host for the TikZ workbench
 * CVM-Role:        Adapter
 * License:         GNU GPL v3
 *
 * Description:     Implements the tikz-workbench host contract for one
 *                  CodeMirror view: the view stores the TikZ source, the main
 *                  process compiles it and projects the Quiver macros, and the
 *                  renderer bundle serves the pinned editor pages.
 *
 * END HEADER
 */

import type { EditorView } from "@codemirror/view";
import { reportError } from "@common/util/error-reporting";
import makeValidUri from "@common/util/make-valid-uri";
import type { TikzWorkbenchHost } from "tikz-workbench/src/host";

export function zettlrTikzWorkbenchHost(view: EditorView): TikzWorkbenchHost {
  return {
    readSource: (from, to) => view.state.sliceDoc(from, to),
    writeSource: (from, to, insert) => {
      view.dispatch({ changes: { from, to, insert } });
    },
    render: async (request) =>
      await window.ipc.invoke("application", { command: "tikz-render", payload: request }),
    quiverMacros: async () => await window.ipc.invoke("quiver-macros"),
    figureUrl: (figure) => makeValidUri(figure.svgPath),
    imageBaseUrl: (docPath) =>
      docPath === ""
        ? ""
        : new URL(
            "./",
            `file://${encodeURI(docPath).replaceAll("#", "%23").replaceAll("?", "%3F")}`,
          ).href,
    // webpack.renderer.config.js copies the pinned pages beside the main window.
    editorUrl: "./tikz-editor/index.html",
    quiverUrl: "./quiver/zettlr-host.html",
    reportError,
  };
}
