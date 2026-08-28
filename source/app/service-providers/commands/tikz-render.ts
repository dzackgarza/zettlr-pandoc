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
 *                  render service in app/util/tikz-render. The configured
 *                  Pandoc data tree, a complete ~/.pandoc tree, or the small
 *                  bundled fallback supplies the filter/template; the SVG
 *                  cache lives in the app's userData directory.
 *
 * END HEADER
 */

import { app } from 'electron'
import path from 'path'
import ZettlrCommand from './zettlr-command'
import {
  renderTikz,
  resolveTikzDataDir,
  type TikzRenderRequest,
  type TikzRenderResult
} from '../../util/tikz-render'
import { type AppServiceContainer } from '../../app-service-container'

export default class TikzRender extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'tikz-render')
  }

  async run (evt: string, arg: TikzRenderRequest): Promise<TikzRenderResult> {
    const tikzAssetDir = resolveTikzDataDir(
      this._app.config.get().tikz.dataDir,
      app.getPath('home'),
      path.join(__dirname, './assets/tikz')
    )
    return await renderTikz(arg, {
      tikzAssetDir,
      cacheDir: path.join(app.getPath('userData'), 'tikz-cache'),
      // The main process is where the app's environment is known, so this is
      // where the decision "renders run under the environment Electron was
      // started with" is made and recorded — the render service never reaches
      // for it.
      env: process.env,
    })
  }
}
