/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzRenderCommand
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Renders a TikZ figure to inline SVG for the editor's
 *                  live preview (issue #14). Thin IPC seam over the
 *                  render service in packages/tikz-render. The filter may
 *                  come from an explicitly configured Pandoc data tree or the
 *                  live ~/.pandoc tree; snippet preamble
 *                  ownership is stricter: ~/.pandoc/templates/
 *                  standalone-tikz.tex is always the template. The SVG cache
 *                  lives in the app's userData directory.
 *
 * END HEADER
 */

import {
  renderTikz,
  type TikzRenderRequest,
  type TikzRenderResult,
} from "@dzack/tikz-render/tikz-render";
import { app } from "electron";
import { type AppServiceContainer } from "../../app-service-container";
import { resolveTikzRenderConfig } from "../../util/resolve-tikz-render-config";
import ZettlrCommand from "./zettlr-command";

export default class TikzRender extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "tikz-render");
  }

  async run(evt: string, arg: TikzRenderRequest): Promise<TikzRenderResult> {
    const config = this._app.config.get().tikz;

    // A pane collapses rapid edits to the newest source. renderTikz runs one
    // render at a time for the whole process, the lint too, and gives this
    // render the turn before the renders of the lint.
    return await renderTikz(
      arg,
      resolveTikzRenderConfig(
        config.dataDir,
        config.figuresDir,
        app.getPath("home"),
        app.getPath("userData"),
        process.env,
      ),
      "preview",
    );
  }
}
