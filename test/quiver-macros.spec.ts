import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { projectQuiverMacros } from 'source/app/util/quiver-macros'
import { tikzTemplateQuiverMacros } from 'source/app/util/tikz-render'

describe('Quiver macro projection', function () {
  let root: string
  let templatePath: string

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), 'zettlr-quiver-macros-'))
    const templates = path.join(root, 'templates')
    const styles = path.join(root, 'styles')
    await mkdir(templates)
    await mkdir(styles)
    templatePath = path.join(templates, 'standalone-tikz.tex')
    await writeFile(templatePath, '\\usepackage{owned}\n', 'utf8')
    await writeFile(
      path.join(styles, 'owned.sty'),
      [
        '\\newcommand{\\TemplateSimple}[1]{\\mathbf{#1}}',
        '\\DeclareMathOperator{\\TemplateOperator}{Spec}',
        '\\newcommand{\\TemplateComplex}[2]{%',
        '  #1 \\otimes #2',
        '}',
      ].join('\n'),
      'utf8'
    )
  })

  afterEach(async function () {
    await rm(root, { recursive: true, force: true })
  })

  it('takes only the faithful one-line subset from the actual template graph', function () {
    assert.deepStrictEqual(tikzTemplateQuiverMacros(templatePath), {
      '\\TemplateSimple': '\\mathbf{#1}',
      '\\TemplateOperator': '\\operatorname{Spec}'
    })
  })

  it('lets the actual TikZ template override the generated MathJax fallback and keeps projection-only macros', function () {
    const projected = projectQuiverMacros({
      TemplateSimple: [ '\\mathcal{#1}', 1 ],
      UserOnly: '\\mathbb{U}'
    }, templatePath)
    assert.strictEqual(projected.macros['\\TemplateSimple'], '\\mathbf{#1}')
    assert.strictEqual(projected.macros['\\UserOnly'], '\\mathbb{U}')
    assert.strictEqual(projected.macros['\\TemplateOperator'], '\\operatorname{Spec}')
    assert.deepStrictEqual(projected.unsupported, [])
  })

  it('reports optional-default macros instead of changing their semantics', function () {
    const projected = projectQuiverMacros({
      Optional: [ '#1+#2', 2, 'x' ]
    }, templatePath)
    assert.ok(!('\\Optional' in projected.macros))
    assert.deepStrictEqual(projected.unsupported, [ '\\Optional' ])
  })

  it('uses a compatible template definition when it supersedes an unsupported MathJax fallback', async function () {
    await writeFile(
      path.join(root, 'styles', 'owned.sty'),
      '\\newcommand{\\Optional}[2]{#1 \\times #2}\n',
      'utf8'
    )
    const projected = projectQuiverMacros({
      Optional: [ '#1+#2', 2, 'x' ]
    }, templatePath)
    assert.strictEqual(projected.macros['\\Optional'], '#1 \\times #2')
    assert.deepStrictEqual(projected.unsupported, [])
  })
})
