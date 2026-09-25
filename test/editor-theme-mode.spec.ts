import { strict as assert } from 'node:assert'
import { useDarkModeEditor } from 'source/common/modules/markdown-editor/theme/dark-mode'

describe('Editor light/dark mode enum contract', function () {
  it('treats light and dark as explicit enum values, with match alone following the app', function () {
    for (const appDarkMode of [ false, true ]) {
      assert.strictEqual(
        useDarkModeEditor(appDarkMode, 'light'),
        false,
        `'light' must select the light editor theme when appDarkMode=${String(appDarkMode)}`
      )
      assert.strictEqual(
        useDarkModeEditor(appDarkMode, 'dark'),
        true,
        `'dark' must select the dark editor theme when appDarkMode=${String(appDarkMode)}`
      )
      assert.strictEqual(
        useDarkModeEditor(appDarkMode, 'match'),
        appDarkMode,
        `'match' alone follows the app when appDarkMode=${String(appDarkMode)}`
      )
    }
  })
})
