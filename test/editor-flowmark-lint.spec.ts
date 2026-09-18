/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CodeMirror Flowmark diagnostic mapping
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { Text } from '@codemirror/state'
import { flowmarkDiagnosticToCodeMirror } from 'source/common/modules/markdown-editor/linters/md-lint'

describe('CodeMirror Flowmark diagnostic mapping', function () {
  it('maps Flowmark 1-based source coordinates exactly', function () {
    const doc = Text.of([ 'first', 'second line', 'third' ])
    const diagnostic = flowmarkDiagnosticToCodeMirror({
      rule: 'format/canonical',
      severity: 'warning',
      message: 'canonical form',
      line: 2,
      column: 2,
      end_line: 2,
      end_column: 7
    }, doc)

    assert.equal(diagnostic.from, doc.line(2).from + 1)
    assert.equal(diagnostic.to, doc.line(2).from + 6)
    assert.equal(diagnostic.source, 'flowmark (format/canonical)')
  })

  it('clamps stale/out-of-bounds coordinates to the live document', function () {
    const doc = Text.of([ 'short' ])
    const diagnostic = flowmarkDiagnosticToCodeMirror({
      rule: 'pandoc/ambiguous-input',
      severity: 'error',
      message: 'bad input',
      line: 99,
      column: 99,
      end_line: 100,
      end_column: 100
    }, doc)

    assert.equal(diagnostic.from, doc.length)
    assert.equal(diagnostic.to, doc.length)
  })
})
