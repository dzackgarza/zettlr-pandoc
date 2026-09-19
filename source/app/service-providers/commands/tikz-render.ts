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
 *                  render service in app/util/tikz-render. The filter may
 *                  come from an explicitly configured Pandoc data tree or the
 *                  live ~/.pandoc tree; snippet preamble
 *                  ownership is stricter: ~/.pandoc/templates/
 *                  standalone-tikz.tex is always the template. The SVG cache
 *                  lives in the app's userData directory.
 *
 * END HEADER
 */

import { Mutex } from "async-mutex";
import { app } from "electron";
import { type AppServiceContainer } from "../../app-service-container";
import { resolveTikzRenderConfig } from "../../util/resolve-tikz-render-config";
import { renderTikz, type TikzRenderRequest, type TikzRenderResult } from "../../util/tikz-render";
import ZettlrCommand from "./zettlr-command";

export default class TikzRender extends ZettlrCommand {
  /** pdflatex is intentionally process-global bounded work, not per-pane work. */
  private readonly renderMutex = new Mutex();

  constructor(app: AppServiceContainer) {
    super(app, "tikz-render");
  }

  async run(evt: string, arg: TikzRenderRequest): Promise<TikzRenderResult> {
    const config = this._app.config.get().tikz;

    // A pane-level live preview already collapses rapid edits to the newest
    // source. The mutex is the second boundary: several panes/inline widgets
    // still cannot fan out into concurrent pdflatex processes and peg the CPU.
    return await this.renderMutex.runExclusive(
      async () =>
        await renderTikz(
          arg,
          resolveTikzRenderConfig(
            config.dataDir,
            config.figuresDir,
            app.getPath("home"),
            app.getPath("userData"),
            process.env,
          ),
        ),
    );
  }
}
