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
 *                  render service in app/util/tikz-render; the vendored
 *                  asset tree ships beside the main bundle and the SVG
 *                  cache lives in the app's userData directory.
 *
 * END HEADER
 */

import { app } from 'electron'
import path from 'path'
import ZettlrCommand from './zettlr-command'
import { renderTikz, type TikzRenderRequest, type TikzRenderResult } from '../../util/tikz-render'
import { type AppServiceContainer } from '../../app-service-container'

export default class TikzRender extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'tikz-render')
  }

  async run (evt: string, arg: TikzRenderRequest): Promise<TikzRenderResult> {
    return await renderTikz(arg, {
      tikzAssetDir: path.join(__dirname, './assets/tikz'),
      cacheDir: path.join(app.getPath('userData'), 'tikz-cache'),
    })
  }
}
