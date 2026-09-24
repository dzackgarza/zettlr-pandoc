import { strict as assert } from 'assert'
import {
  registeredMarkdownDiagnosticProviders,
  registerMarkdownDiagnosticPlugin
} from 'source/common/modules/markdown-editor/diagnostics/markdown-diagnostic-plugins'

describe('Markdown diagnostic plugin registry', function () {
  it('registers providers by id and rejects duplicate ids', function () {
    assert.deepEqual(
      registeredMarkdownDiagnosticProviders(),
      [ 'flowmark', 'language-tool', 'spellcheck' ]
    )
    assert.throws(
      () => registerMarkdownDiagnosticPlugin({
        provider: {
          id: 'flowmark',
          run: () => ({ diagnostics: [] })
        },
        context: () => undefined
      }),
      /already registered/u
    )
  })
})
