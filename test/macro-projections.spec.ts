import assert from 'assert'
import { type MathJaxMacro } from 'source/common/util/mathjax-config'
import { projectMathJaxHeader, projectTexHeader } from 'source/app/service-providers/commands/exporter/macro-projections'

const macros = {
  RR: '\\mathbb{R}',
  vect: [ '\\mathbf{#1}', 1 ],
  inner: [ '\\langle #1, #2 \\rangle', 2, 'x' ]
} as const satisfies Readonly<Record<string, MathJaxMacro>>

describe('Exporter macro projections', function () {
  it('projects string, required-argument, and optional-argument macros into a MathJax header', function () {
    assert.strictEqual(projectMathJaxHeader(macros), [
      '<script>',
      'window.MathJax = {',
      '  "tex": {',
      '    "macros": {',
      '      "RR": "\\\\mathbb{R}",',
      '      "inner": [',
      '        "\\\\langle #1, #2 \\\\rangle",',
      '        2,',
      '        "x"',
      '      ],',
      '      "vect": [',
      '        "\\\\mathbf{#1}",',
      '        1',
      '      ]',
      '    }',
      '  }',
      '};',
      '</script>'
    ].join('\n'))
  })

  it('projects the same macro config into deterministic TeX definitions', function () {
    assert.strictEqual(projectTexHeader(macros), [
      '\\newcommand{\\RR}{\\mathbb{R}}',
      '\\newcommand{\\inner}[2][x]{\\langle #1, #2 \\rangle}',
      '\\newcommand{\\vect}[1]{\\mathbf{#1}}'
    ].join('\n'))
  })

  it('serializes closing script tags safely in MathJax macro bodies', function () {
    assert.strictEqual(projectMathJaxHeader({ escaped: '</script>' }), [
      '<script>',
      'window.MathJax = {',
      '  "tex": {',
      '    "macros": {',
      '      "escaped": "<\\/script>"',
      '    }',
      '  }',
      '};',
      '</script>'
    ].join('\n'))
  })

  it('rejects unsupported macro forms instead of omitting them', function () {
    const unsupported = {
      malformed: [ '\\unsupported' ]
    }

    assert.throws(() => projectMathJaxHeader(unsupported), TypeError)
    assert.throws(() => projectTexHeader(unsupported), TypeError)
  })
})
