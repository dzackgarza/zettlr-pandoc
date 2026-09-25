import { strict as assert } from 'node:assert'
import { DocumentType } from 'source/types/common/documents'
import {
  getDocumentTypeForExtension,
  hasCodeExt
} from 'source/common/util/file-extention-checks'
import {
  isTexMacroSourcePath,
  resolveTexMacroSourcePaths
} from 'source/common/util/tex-macro-source-resolution'

describe('TeX macro source authority paths', function () {
  it('makes .sty and .cls files first-class LaTeX documents', function () {
    assert.equal(hasCodeExt('/notes/macros.sty'), true)
    assert.equal(hasCodeExt('/notes/article.cls'), true)
    assert.equal(getDocumentTypeForExtension('/notes/macros.sty'), DocumentType.LaTeX)
    assert.equal(getDocumentTypeForExtension('/notes/article.cls'), DocumentType.LaTeX)
  })

  it('resolves literal files, directories, and globs over authority-known paths', function () {
    const candidates = [
      '/notes/tex/macros.sty',
      '/notes/tex/classes/local.cls',
      '/notes/tex/readme.md',
      '/notes/shared/operators.tex',
      '/other/outside.sty'
    ]
    assert.deepEqual(
      resolveTexMacroSourcePaths('/notes/chapter.md', [
        'tex',
        'shared/*.tex',
        '../other/outside.sty'
      ], candidates),
      [
        '/notes/shared/operators.tex',
        '/notes/tex/classes/local.cls',
        '/notes/tex/macros.sty',
        '/other/outside.sty'
      ]
    )
  })

  it('does not admit arbitrary non-TeX macro-source files', function () {
    assert.equal(isTexMacroSourcePath('/notes/macros.json'), false)
    assert.deepEqual(
      resolveTexMacroSourcePaths('/notes/chapter.md', [ 'macros.json' ], [ '/notes/macros.json' ]),
      []
    )
  })
})
