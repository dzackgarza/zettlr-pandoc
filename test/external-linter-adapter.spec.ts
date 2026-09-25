/** Generic external-linter to CodeMirror diagnostic mapping. */

import { strict as assert } from 'assert'
import {
  externalDiagnosticToCodeMirror,
  type ExternalLinterAdapter
} from 'source/common/modules/markdown-editor/diagnostics/external-linter-adapter'

const adapter: ExternalLinterAdapter<undefined> = {
  provider: {
    id: 'test',
    run: () => ({ diagnostics: [] })
  },
  context: () => undefined
}

describe('external linter adapter diagnostic mapping', function () {
  it('preserves source offsets and source labels exactly', function () {
    const diagnostic = externalDiagnosticToCodeMirror({
      from: 7,
      to: 12,
      severity: 'warning',
      message: 'heading level jump',
      source: 'Markdown (heading/increment)'
    }, adapter)

    assert.equal(diagnostic.from, 7)
    assert.equal(diagnostic.to, 12)
    assert.equal(diagnostic.source, 'Markdown (heading/increment)')
  })

  it('maps generic replacement actions without provider-specific editor logic', function () {
    const diagnostic = externalDiagnosticToCodeMirror({
      from: 0,
      to: 3,
      severity: 'error',
      message: 'replace this',
      actions: [{
        kind: 'replace',
        name: 'fixed',
        replacement: 'fixed'
      }]
    }, adapter)

    assert.equal(diagnostic.actions?.length, 1)
    assert.equal(diagnostic.actions?.[0].name, 'fixed')
  })
})
