import type { LanguageToolIgnoredRuleEntry } from '../config/get-config-template'
import type { AppServiceContainer } from 'source/app/app-service-container'
import ZettlrCommand from './zettlr-command'

/** Configuration action for LanguageTool rules; lint execution uses the generic registry. */
export default class AddLanguageToolIgnoreRule extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'add-language-tool-ignore-rule')
  }

  async run (_evt: string, rule: LanguageToolIgnoredRuleEntry): Promise<boolean> {
    const allRules = this._app.config.get().editor.lint.languageTool.ignoredRules
    if (allRules.some(existing => existing.id === rule.id)) {
      return false
    }
    allRules.push(rule)
    this._app.config.set(
      'editor.lint.languageTool.ignoredRules',
      JSON.parse(JSON.stringify(allRules))
    )
    return true
  }
}
