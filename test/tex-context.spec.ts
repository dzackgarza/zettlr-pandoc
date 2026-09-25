import { strict as assert } from 'node:assert'
import indexJson from 'source/common/data/texstudio-command-index.json'
import { collectTexContext } from 'source/common/util/tex-context'
import type { TexstudioCommandIndex } from 'source/common/util/texstudio-command-index'

const index = indexJson as TexstudioCommandIndex
const bs = String.fromCharCode(92)

describe('TeX package context', function () {
  it('collects raw TeX, document-class and explicit frontmatter roots', function () {
    const source = [
      '---',
      'tex:',
      '  packages: [amsthm]',
      '  classes: [amsart]',
      '  macro_sources:',
      '    - tex/macros.sty',
      'header-includes:',
      '  - ' + bs + 'usepackage{mathtools}',
      '---',
      '',
      bs + 'RequirePackage{xcolor}',
      '$x+y$'
    ].join('\n')
    const context = collectTexContext(index, source, 'markdown')
    assert.deepEqual(context.packages, [ 'amsthm', 'mathtools', 'xcolor' ])
    assert.deepEqual(context.classes, [ 'class-amsart' ])
    assert.deepEqual(context.macroSources, [ 'tex/macros.sty' ])
  })

  it('does not activate packages mentioned only in ordinary fenced or inline code', function () {
    const source = [
      '~~~tex',
      bs + 'usepackage{mathtools}',
      '~~~',
      'inline code: ' + String.fromCharCode(96) + bs + 'RequirePackage{xcolor}' + String.fromCharCode(96),
      '',
      '~~~{=latex}',
      bs + 'usepackage{amsthm}',
      '~~~',
      String.fromCharCode(96) + bs + 'RequirePackage{graphicx}' + String.fromCharCode(96) + '{=latex}'
    ].join('\n')
    const context = collectTexContext(index, source, 'markdown')
    assert.deepEqual(context.packages, [ 'amsthm', 'graphicx' ])
  })

  it('does not close ordinary fences on fence-like content with trailing text', function () {
    const source = [
      '~~~tex',
      '~~~still code',
      bs + 'usepackage{mathtools}',
      '~~~',
      bs + 'usepackage{xcolor}'
    ].join('\n')
    const context = collectTexContext(index, source, 'markdown')
    assert.deepEqual(context.packages, [ 'xcolor' ])
  })

  it('takes package roots and user commands from authority-supplied TeX sources', function () {
    const context = collectTexContext(index, '', 'markdown', [
      {
        path: '/notes/tex/macros.sty',
        content: [
          bs + 'RequirePackage{mathtools}',
          bs + 'newcommand{' + bs + 'RR}{' + bs + 'mathbb{R}}',
          bs + 'DeclareMathOperator{' + bs + 'Pic}{Pic}',
          bs + 'def' + bs + 'Spec{Spec}'
        ].join('\n')
      },
      { path: '/notes/ignored.json', content: bs + 'usepackage{xcolor}' }
    ])
    assert.deepEqual(context.packages, [ 'mathtools' ])
    assert.deepEqual(context.userCommands, [ bs + 'Pic', bs + 'RR', bs + 'Spec' ])
  })

  it('ignores commented package requirements', function () {
    const context = collectTexContext(index, [
      '% ' + bs + 'usepackage{mathtools}',
      bs + 'usepackage{xcolor} % ' + bs + 'RequirePackage{amsthm}'
    ].join('\n'), 'latex')
    assert.deepEqual(context.packages, [ 'xcolor' ])
  })
})
