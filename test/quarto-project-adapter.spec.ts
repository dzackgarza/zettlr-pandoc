import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { parseQuartoProject } from 'source/common/quarto-project'
import { extractReferences } from 'source/common/pandoc-util/extract-references'

const ROOT = path.join('test', 'fixtures', 'quarto-book')

describe('Quarto project adapter', function () {
  const project = parseQuartoProject(
    ROOT,
    readFileSync(path.join(ROOT, '_quarto.yml'), 'utf8')
  )

  it('projects the authored book structure into ordered navigation', function () {
    assert.deepStrictEqual(project.navigation, [
      { kind: 'chapter', path: 'index.md' },
      {
        kind: 'part',
        title: 'Foundations',
        chapters: [ 'foundations/categories.md', 'foundations/forms.md' ]
      },
      {
        kind: 'part',
        title: 'Computation',
        chapters: [ 'computation/sage.md' ]
      }
    ])
    assert.deepStrictEqual(project.files, [
      'index.md',
      'foundations/categories.md',
      'foundations/forms.md',
      'computation/sage.md'
    ])
  })

  it('resolves every inherited bibliography from the manifest root', function () {
    assert.deepStrictEqual(project.bibliographies, [
      path.resolve(ROOT, 'references.bib'),
      path.resolve(ROOT, 'web.bib')
    ])
  })

  it('indexes Quarto definitions and occurrences through the workspace model', function () {
    const definitionPath = path.join(ROOT, 'foundations', 'categories.md')
    const occurrencePath = path.join(ROOT, 'index.md')
    const definition = extractReferences(definitionPath, readFileSync(definitionPath, 'utf8'))
    const occurrence = extractReferences(occurrencePath, readFileSync(occurrencePath, 'utf8'))

    assert.deepStrictEqual(
      definition.definitions.map(entry => ({ key: entry.key, family: entry.family, title: entry.title })),
      [ { key: 'def-core', family: 'def', title: undefined } ]
    )
    assert.deepStrictEqual(
      occurrence.occurrences.map(entry => ({ key: entry.key, family: entry.family })),
      [ { key: 'def-core', family: 'def' } ]
    )
  })
})
