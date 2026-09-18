/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LintMarkdown command
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     IPC seam over the standalone vendored Flowmark linter.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import { lintMarkdownText } from '../../util/flowmark-lint'
import type { AppServiceContainer } from '../../app-service-container'
import type { FlowmarkLintRequest, FlowmarkLintResult } from '@dts/common/flowmark-lint'

export default class LintMarkdown extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'lint-markdown')
  }

  async run (_evt: string, request: FlowmarkLintRequest): Promise<FlowmarkLintResult> {
    return await lintMarkdownText(request.text, {
      env: process.env,
      sourcePath: request.sourcePath
    })
  }
}
