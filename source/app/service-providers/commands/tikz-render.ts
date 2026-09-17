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

import { app } from 'electron'
import path from 'path'
import { Mutex } from 'async-mutex'
import ZettlrCommand from './zettlr-command'
import {
  renderTikz,
  resolveTikzDataDir,
  resolveTikzTemplatePath,
  type TikzRenderRequest,
  type TikzRenderResult
} from '../../util/tikz-render'
import { type AppServiceContainer } from '../../app-service-container'

export default class TikzRender extends ZettlrCommand {
  /** pdflatex is intentionally process-global bounded work, not per-pane work. */
  private readonly renderMutex = new Mutex()

  constructor (app: AppServiceContainer) {
    super(app, 'tikz-render')
  }

  async run (evt: string, arg: TikzRenderRequest): Promise<TikzRenderResult> {
    const tikzAssetDir = resolveTikzDataDir(
      this._app.config.get().tikz.dataDir,
      app.getPath('home')
    )
    const templatePath = resolveTikzTemplatePath(app.getPath('home'))

    // A pane-level live preview already collapses rapid edits to the newest
    // source. The mutex is the second boundary: several panes/inline widgets
    // still cannot fan out into concurrent pdflatex processes and peg the CPU.
    return await this.renderMutex.runExclusive(async () => await renderTikz(arg, {
      tikzAssetDir,
      templatePath,
      cacheDir: path.join(app.getPath('userData'), 'tikz-cache'),
      // The main process is where the app's environment is known, so this is
      // where the decision "renders run under the environment Electron was
      // started with" is made and recorded — the render service never reaches
      // for it.
      env: process.env,
    }))
  }
}
