/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        review-diff CLI request specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the issue #34 main-process request boundary: parse a
 *                  single-document unified patch, reject unsupported patch
 *                  shapes, and fence the exact normalized baseline hash before
 *                  any document opens.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { createTwoFilesPatch } from 'diff'
import {
  buildReviewDiffSession,
  parseReviewDiffCliRequest,
  sha256Text,
  validateReviewDiffInvocation
} from 'source/app/util/review-diff'

describe('review-diff CLI request boundary', function () {
  let scratch: string

  beforeEach(function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'zettlr-review-diff-'))
  })

  afterEach(function () {
    rmSync(scratch, { recursive: true, force: true })
  })

  function writeScratch (name: string, content: string): string {
    const filePath = path.join(scratch, name)
    writeFileSync(filePath, content, 'utf8')
    return filePath
  }

  it('builds a fenced single-document review session from a valid multi-hunk patch', function () {
    const baseline = [
      '# Note',
      '',
      'first baseline',
      '',
      'middle unchanged',
      '',
      'second baseline',
      ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')

    const documentPath = writeScratch('note.md', baseline)
    const patchPath = writeScratch('note.diff', createTwoFilesPatch('a/note.md', 'b/note.md', baseline, proposed))
    const baselineSha256 = sha256Text(baseline)
    const request = parseReviewDiffCliRequest([
      'zettlr-pandoc',
      'review-diff',
      '--document',
      'note.md',
      '--patch',
      'note.diff',
      '--baseline-sha256',
      baselineSha256
    ], scratch)

    assert.ok(request !== null)
    const session = buildReviewDiffSession(request)

    assert.equal(session.documentPath, documentPath)
    assert.equal(session.patchPath, patchPath)
    assert.equal(session.baselineSha256, baselineSha256)
    assert.equal(session.baselineText, baseline)
    assert.equal(session.proposedText, proposed)
    assert.equal(readFileSync(documentPath, 'utf8'), baseline, 'building the session must not modify the target document')
  })

  it('rejects a mismatched baseline hash before accepting a proposition', function () {
    const baseline = 'alpha\nbeta\n'
    const proposed = 'alpha\nBETTER\n'
    const documentPath = writeScratch('note.md', baseline)
    const patchPath = writeScratch('note.diff', createTwoFilesPatch('a/note.md', 'b/note.md', baseline, proposed))
    const request = {
      documentPath,
      patchPath,
      baselineSha256: sha256Text('different\n')
    }

    assert.throws(
      () => buildReviewDiffSession(request),
      /baseline hash does not match/
    )
    assert.equal(readFileSync(documentPath, 'utf8'), baseline)
  })

  it('rejects a non-applicable patch without changing the target document', function () {
    const baseline = 'alpha\nbeta\n'
    const staleBaseline = 'alpha\ngamma\n'
    const proposed = 'alpha\nGAMMA\n'
    const documentPath = writeScratch('note.md', baseline)
    const patchPath = writeScratch('note.diff', createTwoFilesPatch('a/note.md', 'b/note.md', staleBaseline, proposed))

    assert.throws(
      () => validateReviewDiffInvocation([
        'zettlr-pandoc',
        'review-diff',
        '--document',
        documentPath,
        '--patch',
        patchPath
      ]),
      /does not apply/
    )
    assert.equal(readFileSync(documentPath, 'utf8'), baseline)
  })

  it('rejects malformed, multi-file, and create/delete patch shapes', function () {
    const baseline = 'alpha\nbeta\n'
    const proposed = 'alpha\nBETA\n'
    const documentPath = writeScratch('note.md', baseline)
    const malformed = writeScratch('malformed.diff', 'not a unified patch\n')
    const multiFile = writeScratch(
      'multi.diff',
      createTwoFilesPatch('a/note.md', 'b/note.md', baseline, proposed) +
        createTwoFilesPatch('a/other.md', 'b/other.md', 'x\n', 'y\n')
    )
    const createPatch = writeScratch(
      'create.diff',
      [
        'diff --git a/new.md b/new.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1 @@',
        '+new',
        ''
      ].join('\n')
    )

    for (const [patchPath, pattern] of [
      [malformed, /at least one hunk/],
      [multiFile, /exactly one file patch/],
      [createPatch, /create or delete|rename, copy, create, or delete/]
    ] as Array<[string, RegExp]>) {
      assert.throws(
        () => buildReviewDiffSession({ documentPath, patchPath }),
        pattern
      )
    }
    assert.equal(readFileSync(documentPath, 'utf8'), baseline)
  })
})
