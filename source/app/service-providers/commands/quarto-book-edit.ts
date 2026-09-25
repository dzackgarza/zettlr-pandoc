import type { AppServiceContainer } from 'source/app/app-service-container'
import type { ProjectSettings } from '@dts/common/fsal'
import ZettlrCommand from './zettlr-command'
import { editQuartoBookManifest, type QuartoBookEdit } from 'source/app/util/quarto-book-editor'

export interface QuartoBookEditRequest {
  rootPath: string
  edit: QuartoBookEdit
}

/** Edits the Quarto book file and returns the refreshed project settings. */
export default class QuartoBookEditCommand extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'quarto-book-edit')
  }

  async run (_evt: string, arg: QuartoBookEditRequest): Promise<ProjectSettings> {
    const dir = await this._app.fsal.getAnyDirectoryDescriptor(arg.rootPath)
    if (dir === undefined) {
      throw new Error(`Can't edit the Quarto book because ${arg.rootPath} is not open`)
    }
    const project = dir.settings.project
    if (project?.manifest.kind !== 'quarto') {
      throw new Error(`${arg.rootPath} is not a Quarto book project`)
    }

    await editQuartoBookManifest(dir.path, project.manifest.path, arg.edit)
    await this._app.fsal.refreshQuartoProject(dir)

    const refreshed = dir.settings.project
    if (refreshed?.manifest.kind !== 'quarto') {
      throw new Error(`Couldn't reload the Quarto book after saving changes`)
    }
    return refreshed
  }
}
