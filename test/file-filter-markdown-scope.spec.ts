import { strict as assert } from 'assert'
import type {
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor
} from 'source/types/common/fsal'
import { DEFAULT_FILE_PICKER_INCLUDE } from 'source/app/service-providers/config/get-config-template'
import { defaultKeybindings } from 'source/app/service-providers/menu/shortcuts'
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

describe('Ctrl+Shift+P persistent file-picker policy', function () {
  const defaultRules = { include: DEFAULT_FILE_PICKER_INCLUDE, exclude: [] }

  it('keeps Ctrl+Shift+P/Cmd+Shift+P as the file-picker shortcut', function () {
    assert.deepEqual(defaultKeybindings['filter-files'], {
      key: 'Ctrl-Shift-p',
      mac: 'Cmd-Shift-p'
    })
  })

  it('keeps the ordinary file filter broad when the opt-in scope is inactive', function () {
    const filter = matchQuery('', false, false)
    assert.equal(filter(markdown), true)
    assert.equal(filter(latex), true)
    assert.equal(filter(directory), true)
  })

  it('applies transient text matching after the permanent Markdown-only policy', function () {
    const matching = matchQuery('theorem', false, false, defaultRules)
    const missing = matchQuery('lemma', false, false, defaultRules)
    assert.equal(matching(markdown), true)
    assert.equal(matching(latex), false)
    assert.equal(missing(markdown), false)
  })
})
