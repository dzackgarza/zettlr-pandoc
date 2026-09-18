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
import type { FlowmarkLintResult } from '@dts/common/flowmark-lint'

export default class LintMarkdown extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'lint-markdown')
  }

  async run (_evt: string, text: string): Promise<FlowmarkLintResult> {
    return await lintMarkdownText(text, { env: process.env })
  }
}
