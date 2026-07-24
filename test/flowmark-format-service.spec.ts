/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Main-process flowmark format service contract (issue #26)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the flowmark service's typed outcomes over the REAL
 *                  write-temp -> run -> read-back roundtrip. flowmark itself is
 *                  a uvx external tool, so the runner command is injected here
 *                  with ordinary POSIX utilities that stand in for the three
 *                  cases the caller must distinguish: the binary is absent
 *                  (flowmark-absent), it runs but fails (flowmark-error), and
 *                  it succeeds and the file is read back (ok). Absence is a
 *                  typed result the editor surfaces, never a silent no-op.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { formatMarkdownText } from 'source/app/util/flowmark-format'

describe('flowmark format service (issue #26)', function () {
  it('reports a typed flowmark-absent result when the runner binary does not exist', async function () {
    const result = await formatMarkdownText('The cat sat.\n', {
      command: 'zettlr-no-such-binary-xyzzy',
      argsPrefix: []
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.kind, 'flowmark-absent', 'a missing runner must be typed as absent, not swallowed')
    }
  })

  it('reports a typed flowmark-error when the runner exits non-zero', async function () {
    // `false` exits 1 without touching the file.
    const result = await formatMarkdownText('The cat sat.\n', {
      command: 'false',
      argsPrefix: []
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.kind, 'flowmark-error', 'a non-zero exit must be typed as an error')
    }
  })

  it('reads the (possibly rewritten) temp file back on success', async function () {
    // `true` exits 0 and leaves the temp file exactly as written, so the
    // roundtrip returns the input bytes — proving write -> run -> read-back.
    const text = 'The cat sat.  The dog ran.\n'
    const result = await formatMarkdownText(text, { command: 'true', argsPrefix: [] })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.formatted, text)
    }
  })

  it('returns the rewritten bytes when the runner edits the temp file in place', async function () {
    // A runner that appends a marker to its last argument (the temp file)
    // stands in for flowmark's --inplace rewrite; the service must surface the
    // rewritten bytes, not the original input.
    const result = await formatMarkdownText('original\n', {
      command: 'sh',
      argsPrefix: [ '-c', 'printf "formatted\\n" > "$1"', 'sh' ]
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.formatted, 'formatted\n')
    }
  })
})
