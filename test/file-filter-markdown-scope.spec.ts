import { strict as assert } from 'assert'
import type {
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor
} from 'source/types/common/fsal'
import matchQuery from 'source/win-main/file-manager/util/match-query'

const markdown: MDFileDescriptor = {
  path: '/notes/theorem.md',
  dir: '/notes',
  name: 'theorem.md',
  type: 'file',
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: '.md',
  id: '',
  tags: [],
  links: [],
  citekeys: [],
  bom: '',
  wordCount: 1,
  charCount: 1,
  firstHeading: 'Theorem',
  yamlTitle: undefined,
  frontmatter: null,
  linefeed: '\n',
  references: {
    documentPath: '/notes/theorem.md',
    sourceHash: '',
    definitions: [],
    occurrences: []
  }
}

const latex: CodeFileDescriptor = {
  path: '/notes/theorem.tex',
  dir: '/notes',
  name: 'theorem.tex',
  type: 'code',
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: '.tex',
  bom: '',
  linefeed: '\n'
}

const directory: DirDescriptor = {
  path: '/notes',
  dir: '/',
  name: 'notes',
  type: 'directory',
  size: 1,
  modtime: 0,
  creationtime: 0,
  settings: {
    sorting: 'name-up',
    icon: null,
    project: null,
    color: null,
    quartoManifest: null
  },
  isGitRepository: false
}

describe('Ctrl+Shift+P Markdown file-filter scope', function () {
  it('keeps the ordinary file filter broad when the opt-in scope is inactive', function () {
    const filter = matchQuery('', false, false)
    assert.equal(filter(markdown), true)
    assert.equal(filter(latex), true)
    assert.equal(filter(directory), true)
  })

  it('restricts an empty quick-filter query to Markdown descriptors when opted in', function () {
    const filter = matchQuery('', false, false, true)
    assert.equal(filter(markdown), true)
    assert.equal(filter(latex), false)
    assert.equal(filter(directory), false)
  })

  it('applies text matching inside the Markdown-only scope', function () {
    const matching = matchQuery('theorem', false, false, true)
    const missing = matchQuery('lemma', false, false, true)
    assert.equal(matching(markdown), true)
    assert.equal(matching(latex), false)
    assert.equal(missing(markdown), false)
  })
})
