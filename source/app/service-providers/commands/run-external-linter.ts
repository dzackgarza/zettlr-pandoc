import type {
  ExternalLinterRunRequest,
  ExternalLinterRunResponse
} from '@common/diagnostics/external-linter'
import type { AppServiceContainer } from 'source/app/app-service-container'
import { runExternalLinter } from 'source/app/util/external-linter-registry'
import ZettlrCommand from './zettlr-command'

export default class RunExternalLinter extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'run-external-linter')
  }

  async run (
    _evt: string,
    request: ExternalLinterRunRequest
  ): Promise<ExternalLinterRunResponse> {
    return await runExternalLinter(this._app, request)
  }
}
