import { strict as assert } from 'assert'
import type { MDFileDescriptor } from 'source/types/common/fsal'
import { getSemanticDescriptorTitle } from 'source/win-main/util/get-document-title'
import { documentTitleMetadata } from 'source/common/util/document-title-metadata'

function descriptor (path = '/tmp/title.md'): MDFileDescriptor {
  return {
    path,
    dir: '/tmp',
    name: 'title.md',
    type: 'file',
    size: 0,
    modtime: 0,
    creationtime: 0,
    ext: '.md',
    id: '',
    tags: [],
    links: [],
    citekeys: [],
    bom: '',
    wordCount: 0,
    charCount: 0,
    firstHeading: null,
    firstSentence: null,
    yamlTitle: undefined,
    frontmatter: null,
    linefeed: '\n',
    references: {
      documentPath: path,
      sourceHash: '',
      definitions: [],
      occurrences: []
    }
  }
}

describe('document title metadata', function () {
  it('uses the first authored heading regardless of depth', function () {
    const file = descriptor()
    const metadata = documentTitleMetadata([
      '### Lattice Folding',
      '',
      'and thus',
      '$$',
      'G_{\\Phi(A_5^G)} =',
      '\\begin{pmatrix}',
      '4 & -2 \\\\',
      '-2 & 4',
      '\\end{pmatrix}',
      '=',
      'G_{B_3}',
      '$$'
    ].join('\n'))
    file.firstHeading = metadata.firstHeading
    file.firstSentence = metadata.firstSentence

    assert.equal(file.firstHeading, 'Lattice Folding')
    assert.equal(getSemanticDescriptorTitle(file), 'Lattice Folding')
  })

  it('does not treat display-math Setext artifacts as authored headings', function () {
    const file = descriptor()
    const metadata = documentTitleMetadata([
      'A prose sentence before the calculation.',
      '',
      '$$',
      'G_A =',
      '\\begin{pmatrix}',
      '4 & -2 \\\\',
      '-2 & 4',
      '\\end{pmatrix}',
      '=',
      'G_B',
      '$$'
    ].join('\n'))
    file.firstHeading = metadata.firstHeading
    file.firstSentence = metadata.firstSentence

    assert.equal(file.firstHeading, null)
    assert.equal(file.firstSentence, 'A prose sentence before the calculation.')
    assert.equal(getSemanticDescriptorTitle(file), 'A prose sentence before the calculation.')
  })

  it('prefers YAML title over the first heading', function () {
    const file = descriptor()
    file.yamlTitle = 'YAML Wins'
    const metadata = documentTitleMetadata('### Heading Loses')
    file.firstHeading = metadata.firstHeading
    file.firstSentence = metadata.firstSentence

    assert.equal(file.yamlTitle, 'YAML Wins')
    assert.equal(file.firstHeading, 'Heading Loses')
    assert.equal(getSemanticDescriptorTitle(file), 'YAML Wins')
  })

  it('falls back to prose only up to the first math region when there is no heading', function () {
    const file = descriptor()
    const metadata = documentTitleMetadata('A useful description before $x+y$ and text after it. Second sentence.')
    file.firstHeading = metadata.firstHeading
    file.firstSentence = metadata.firstSentence

    assert.equal(file.firstHeading, null)
    assert.equal(file.firstSentence, 'A useful description before')
    assert.equal(getSemanticDescriptorTitle(file), 'A useful description before')
  })

  it('uses the first sentence when there is no heading and no early math', function () {
    const file = descriptor()
    const metadata = documentTitleMetadata('The first sentence is enough. A second sentence should not appear.')
    file.firstHeading = metadata.firstHeading
    file.firstSentence = metadata.firstSentence

    assert.equal(file.firstSentence, 'The first sentence is enough.')
    assert.equal(getSemanticDescriptorTitle(file), 'The first sentence is enough.')
  })
})
