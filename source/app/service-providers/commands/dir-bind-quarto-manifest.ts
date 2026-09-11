/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DirBindQuartoManifest command
 * CVM-Role:        <none>
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Binds a directory to the Quarto manifest that describes it,
 *                  or removes that binding.
 *
 * END HEADER
 */

import type { AppServiceContainer } from 'source/app/app-service-container'
import ZettlrCommand from './zettlr-command'
import type { QuartoManifestBinding } from '../fsal/fsal-directory'

export interface DirBindQuartoManifestAPI {
  path: string
  /** The manifest to bind to, or null to unbind the directory. */
  manifest: string|null
}

export type DirBindQuartoManifestOutcome =
  | QuartoManifestBinding
  | { kind: 'unbound' }
  | { kind: 'rejected', reason: 'no-such-directory' }

export default class DirBindQuartoManifest extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'dir-bind-quarto-manifest')
  }

  /**
   * Binds the directory to a manifest, or unbinds it.
   *
   * @param   {string}                       evt  The event name
   * @param   {DirBindQuartoManifestAPI}     arg  The directory and manifest
   *
   * @return  {Promise<DirBindQuartoManifestOutcome>}  What became of the binding
   */
  async run (evt: string, arg: DirBindQuartoManifestAPI): Promise<DirBindQuartoManifestOutcome> {
    const dir = await this._app.fsal.getAnyDirectoryDescriptor(arg.path)

    if (dir === undefined) {
      return { kind: 'rejected', reason: 'no-such-directory' }
    }

    if (arg.manifest === null) {
      await this._app.fsal.unbindQuartoManifest(dir)
      return { kind: 'unbound' }
    }

    return await this._app.fsal.bindQuartoManifest(dir, arg.manifest)
  }
}
