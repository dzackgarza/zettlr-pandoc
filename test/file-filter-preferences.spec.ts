import { strict as assert } from 'assert'
import type {
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor,
  OtherFileDescriptor
} from 'source/types/common/fsal'
import { DEFAULT_FILE_FILTER_INCLUDE } from 'source/app/service-providers/config/get-config-template'
import { getFileManagerFields } from 'source/win-preferences/schema/file-manager'
import { buildFilePickerCache } from 'source/win-main/file-manager/util/match-query'
import {
  createFileManagerVisibilityFilter,
  type FileManagerFilterRules,
  type FileManagerVisibilityConfig
} from 'source/win-main/file-manager/util/filter-children'

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

const yaml = {
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
} satisfies DirDescriptor

const hiddenDirectory = {
  ...directory,
  path: '/notes/build',
  dir: '/notes',
  name: 'build'
} satisfies DirDescriptor

const nestedMarkdown = {
  ...markdown,
  path: '/notes/build/hidden.md',
  dir: '/notes/build',
  name: 'hidden.md',
  references: {
    ...markdown.references,
    documentPath: '/notes/build/hidden.md'
  }
} satisfies MDFileDescriptor

function visibilityConfig (
  filters: FileManagerFilterRules,
  hiddenDirectories: string[] = [],
  showHiddenDirectories = false
): FileManagerVisibilityConfig {
  return {
    attachmentExtensions: [],
    fileManager: {
      filters,
      hiddenDirectories,
      showHiddenDirectories
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
}

describe('unified permanent file filters', function () {
  it('defaults Include to all Markdown extensions and Exclude to empty', function () {
    assert.deepEqual(
      DEFAULT_FILE_FILTER_INCLUDE,
      [ '.md', '.rmd', '.qmd', '.markdown', '.txt', '.mdx', '.mkd' ]
    )
  })

  it('applies extension exclusions before built-in File Treatment', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig({
      include: [ '.md', '.yaml' ],
      exclude: [ '.yaml' ]
    }))

    assert.equal(visible(markdown), true)
    assert.equal(visible(yaml), false)
  })

  it('builds the Ctrl+Shift+P cache from the exact file-manager-visible set', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig({
      include: [ '.md', '.yaml' ],
      exclude: [ '.yaml' ]
    }))
    const cache = buildFilePickerCache(
      [ markdown, yaml, latex, pdf, directory ],
      visible
    )

    assert.equal(visible(yaml), false)
    assert.deepEqual(cache.paths, [ markdown.path ])
    assert.equal(cache.pathSet.has(markdown.path), true)
    assert.equal(cache.pathSet.has(yaml.path), false)
    assert.equal(cache.pathSet.has(directory.path), false)
  })

  it('uses an empty Include list as all file types permitted by File Treatment', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig({
      include: [],
      exclude: [ '.yaml' ]
    }))

    assert.equal(visible(markdown), true)
    assert.equal(visible(latex), true)
    assert.equal(visible(pdf), true)
    assert.equal(visible(yaml), false)
    assert.equal(visible(directory), true)
  })

  it('hides an explicitly hidden folder and every descendant', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig(
      { include: [], exclude: [] },
      [ hiddenDirectory.path ]
    ))

    assert.equal(visible(hiddenDirectory), false)
    assert.equal(visible(nestedMarkdown), false)
    assert.equal(visible(markdown), true)
  })

  it('reveals all hidden folders without clearing their flags', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig(
      { include: [], exclude: [] },
      [ hiddenDirectory.path ],
      true
    ))

    assert.equal(visible(hiddenDirectory), true)
    assert.equal(visible(nestedMarkdown), true)
  })

  it('keeps hidden subtrees out of the Ctrl+Shift+P cache', function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig(
      { include: [], exclude: [] },
      [ hiddenDirectory.path ]
    ))
    const cache = buildFilePickerCache(
      [ markdown, hiddenDirectory, nestedMarkdown ],
      visible
    )

    assert.deepEqual(cache.paths, [ markdown.path ])
  })

  it('exposes both rules in Preferences → File Manager', function () {
    const models = getFileManagerFields({ fileNameDisplay: 'filename' })
      .flatMap(fieldset => fieldset.fields)
      .flatMap(field => 'model' in field ? [ field.model ] : [])

    assert.ok(models.includes('fileManager.filters.include'))
    assert.ok(models.includes('fileManager.filters.exclude'))
    assert.ok(models.includes('fileManager.hiddenDirectories'))
    assert.ok(models.includes('fileManager.showHiddenDirectories'))
  })
})
