import { strict as assert } from 'assert'
import type {
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor
} from 'source/types/common/fsal'
import { defaultKeybindings } from 'source/app/service-providers/menu/shortcuts'
import matchQuery from 'source/win-main/file-manager/util/match-query'
import {
  createFileManagerVisibilityFilter,
  type FileManagerVisibilityConfig
} from 'source/win-main/file-manager/util/filter-children'

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

const yaml: CodeFileDescriptor = {
  path: '/notes/project.yaml',
  dir: '/notes',
  name: 'project.yaml',
  type: 'code',
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: '.yaml',
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
    explorer: {
      displayName: 'inherit',
      sortMetadataKey: 'zettlr-order_',
      foldersFirst: null,
      projectFilter: 'all'
    },
    icon: null,
    project: null,
    color: null,
    quartoManifest: null
  },
  isGitRepository: false
}

const visibilityConfig: FileManagerVisibilityConfig = {
  attachmentExtensions: [],
  fileManager: {
    filters: {
      include: [ '.md', '.tex', '.yaml' ],
      exclude: [ '.yaml' ]
    },
    hiddenDirectories: [],
    showHiddenDirectories: false
  },
  files: {
    builtin: { showInFilemanager: true, openWith: 'zettlr' },
    images: { showInFilemanager: true, openWith: 'system' },
    pdf: { showInFilemanager: true, openWith: 'system' },
    msoffice: { showInFilemanager: true, openWith: 'system' },
    openOffice: { showInFilemanager: true, openWith: 'system' },
    dataFiles: { showInFilemanager: true, openWith: 'system' },
    dotFiles: { showInFilemanager: false, openWith: 'system' }
  }
}

describe('Ctrl+Shift+P shared file-manager visibility', function () {

  it('keeps Ctrl+Shift+P/Cmd+Shift+P as the file-picker shortcut', function () {
    assert.deepEqual(defaultKeybindings['filter-files'], {
      key: 'Ctrl-Shift-p',
      mac: 'Cmd-Shift-p'
    })
  })

  it('applies transient text matching only after permanent visibility', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig)
    const matching = matchQuery('theorem', false, false)

    assert.equal(visible(markdown) && matching(markdown), true)
    assert.equal(visible(latex) && matching(latex), true)
    assert.equal(visible(yaml) && matchQuery('project', false, false)(yaml), false)
    assert.equal(visible(directory), true)
  })
})
