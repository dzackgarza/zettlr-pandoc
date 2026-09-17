import type { AppServiceContainer } from 'source/app/app-service-container'
import type { ProjectSettings } from '@dts/common/fsal'
import ZettlrCommand from './zettlr-command'
import { editQuartoBookManifest, type QuartoBookEdit } from 'source/app/util/quarto-book-editor'

export interface QuartoBookEditRequest {
  rootPath: string
  edit: QuartoBookEdit
}

/** Mutates the authoritative Quarto manifest and returns its fresh projection. */
export default class QuartoBookEditCommand extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'quarto-book-edit')
  }

  async run (_evt: string, arg: QuartoBookEditRequest): Promise<ProjectSettings> {
    const dir = await this._app.fsal.getAnyDirectoryDescriptor(arg.rootPath)
    if (dir === undefined) {
      throw new Error(`Cannot edit Quarto book: ${arg.rootPath} is not a loaded workspace directory`)
    }
    const project = dir.settings.project
    if (project?.manifest.kind !== 'quarto') {
      throw new Error(`Cannot edit Quarto book: ${arg.rootPath} is not a Quarto project`)
    }

    await editQuartoBookManifest(dir.path, project.manifest.path, arg.edit)
    await this._app.fsal.refreshQuartoProject(dir)

    const refreshed = dir.settings.project
    if (refreshed?.manifest.kind !== 'quarto') {
      throw new Error(`Quarto manifest edit left ${arg.rootPath} without a readable book project`)
    }
    return refreshed
  }
}
