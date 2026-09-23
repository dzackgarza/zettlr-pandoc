import { strict as assert } from 'assert'
import type {
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor,
  OtherFileDescriptor
} from 'source/types/common/fsal'
import { DEFAULT_QUICK_FILTER_INCLUDE } from 'source/app/service-providers/config/get-config-template'
import { getFileManagerFields } from 'source/win-preferences/schema/file-manager'
import matchQuery from 'source/win-main/file-manager/util/match-query'

const markdown = {
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
} satisfies MDFileDescriptor

const latex = {
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
} satisfies CodeFileDescriptor

const pdf = {
  path: '/notes/reference.pdf',
  dir: '/notes',
  name: 'reference.pdf',
  type: 'other',
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: '.pdf'
} satisfies OtherFileDescriptor

const directory = {
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
} satisfies DirDescriptor

describe('quick file-filter preferences', function () {
  it('defaults Include to all Markdown extensions and Exclude to empty', function () {
    const rules = { include: DEFAULT_QUICK_FILTER_INCLUDE, exclude: [] }
    const filter = matchQuery('', false, false, rules)
    assert.equal(filter(markdown), true)
    assert.equal(filter(latex), false)
    assert.equal(filter(pdf), false)
    assert.equal(filter(directory), false)
  })

  it('applies Include first and lets Exclude win', function () {
    const include = { include: [ '.md', '.tex', 'PDF' ], exclude: [] }
    assert.equal(matchQuery('', false, false, include)(markdown), true)
    assert.equal(matchQuery('', false, false, include)(latex), true)
    assert.equal(matchQuery('', false, false, include)(pdf), true)

    const exclude = { include: [ '.md', '.tex' ], exclude: [ '.md' ] }
    assert.equal(matchQuery('', false, false, exclude)(markdown), false)
    assert.equal(matchQuery('', false, false, exclude)(latex), true)
  })

  it('uses an empty Include list as all file types but never offers folders', function () {
    const rules = { include: [], exclude: [] }
    assert.equal(matchQuery('', false, false, rules)(markdown), true)
    assert.equal(matchQuery('', false, false, rules)(latex), true)
    assert.equal(matchQuery('', false, false, rules)(pdf), true)
    assert.equal(matchQuery('', false, false, rules)(directory), false)
  })

  it('exposes both rules in Preferences → File Manager', function () {
    const models = getFileManagerFields({ fileNameDisplay: 'filename' })
      .flatMap(fieldset => fieldset.fields)
      .flatMap(field => 'model' in field ? [ field.model ] : [])

    assert.ok(models.includes('fileManager.quickFilter.include'))
    assert.ok(models.includes('fileManager.quickFilter.exclude'))
  })
})
