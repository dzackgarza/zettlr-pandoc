/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark lint service contract
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves the Zettlr main-process adapter is only a transport:
 *                  stdin goes to the standalone Flowmark linter, valid JSON
 *                  diagnostics come back typed, malformed output fails loud,
 *                  and an absent runner is never silently treated as clean.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { lintMarkdownText } from 'source/app/util/flowmark-lint'

describe('Flowmark lint service', function () {
  it('transports the standalone JSON diagnostic contract', async function () {
    const payload = JSON.stringify({
      version: 1,
      files: [{
        path: '-',
        diagnostics: [{
          rule: 'reference/undefined',
          severity: 'warning',
          message: 'undefined reference',
          line: 2,
          column: 3,
          end_line: 2,
          end_column: 8,
          replacement: null
        }]
      }]
    })
    const result = await lintMarkdownText('ignored input', {
      command: process.execPath,
      args: [ '-e', `process.stdout.write(${JSON.stringify(payload)})` ]
    })

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.diagnostics, [{
        rule: 'reference/undefined',
        severity: 'warning',
        message: 'undefined reference',
        line: 2,
        column: 3,
        end_line: 2,
        end_column: 8,
        replacement: null
      }])
    }
  })

  it('rejects malformed linter output instead of inventing clean diagnostics', async function () {
    const result = await lintMarkdownText('text', {
      command: process.execPath,
      args: [ '-e', 'process.stdout.write("not-json")' ]
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.kind, 'flowmark-invalid-output')
    }
  })

  it('reports a missing runner as a typed failure', async function () {
    const result = await lintMarkdownText('text', {
      command: 'zettlr-no-such-flowmark-runner-xyzzy',
      args: []
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.kind, 'flowmark-absent')
    }
  })
})
