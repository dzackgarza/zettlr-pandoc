import { strict as assert } from 'node:assert'
import type { AnyDescriptor, DirDescriptor, MDFileDescriptor, ProjectSettings, SortMethod } from 'source/types/common/fsal'
import {
  effectiveExplorerDisplay,
  projectMembershipForPath,
  sortExplorerChildren,
  type ExplorerSortDefaults
} from 'source/common/util/explorer-ordering'

const DEFAULTS: ExplorerSortDefaults = {
  sortingType: 'natural',
  sortFoldersFirst: true,
  fileNameDisplay: 'title+heading',
  appLang: 'en-US',
  fileMetaTime: 'modtime'
}

function directory (
  path: string,
  sorting: SortMethod = 'name-up',
  project: ProjectSettings|null = null
): DirDescriptor {
  const segments = path.split('/')
  return {
    path,
    dir: segments.slice(0, -1).join('/') || '/',
    name: segments.at(-1) ?? path,
    type: 'directory',
    size: 0,
    modtime: 0,
    creationtime: 0,
    isGitRepository: false,
    settings: {
      sorting,
      explorer: {
        displayName: 'inherit',
        sortMetadataKey: 'zettlr-order_',
        foldersFirst: null,
        projectFilter: 'all'
      },
      project,
      icon: null,
      color: null,
      quartoManifest: null
    }
  }
}

function markdown (
  filePath: string,
  options: {
    title?: string
    heading?: string
    frontmatter?: Record<string, unknown>
    modtime?: number
    creationtime?: number
  } = {}
): MDFileDescriptor {
  const name = filePath.split('/').at(-1) ?? filePath
  return {
    path: filePath,
    dir: filePath.slice(0, filePath.length - name.length - 1),
    name,
    type: 'file',
    size: 0,
    modtime: options.modtime ?? 0,
    creationtime: options.creationtime ?? 0,
    ext: '.md',
    id: '',
    tags: [],
    links: [],
    citekeys: [],
    bom: '',
    wordCount: 0,
    charCount: 0,
    firstHeading: options.heading ?? null,
    yamlTitle: options.title,
    frontmatter: { ...(options.frontmatter ?? {}), ...(options.title === undefined ? {} : { title: options.title }) },
    linefeed: '\n',
    references: { documentPath: filePath, sourceHash: '', definitions: [], occurrences: [] }
  }
}

function quartoProject (files: string[]): ProjectSettings {
  return {
    manifest: { kind: 'quarto', path: '/book/_quarto.yml', bibliographies: [], navigation: [] },
    title: 'Book',
    profiles: [],
    files,
    cslStyle: '',
    templates: { tex: '', html: '' }
  }
}

describe('Explorer ordering', function () {
  it('decouples the visible title from filename ordering', function () {
    const root = directory('/book', 'filename-up')
    root.settings.explorer.displayName = 'title'
    const children = [
      markdown('/book/z.md', { title: 'A title' }),
      markdown('/book/a.md', { title: 'Z title' })
    ]

    assert.equal(effectiveExplorerDisplay(root, DEFAULTS.fileNameDisplay), 'title')
    assert.deepEqual(
      sortExplorerChildren(root, children, DEFAULTS, [root]).map(item => item.name),
      [ 'a.md', 'z.md' ],
      'displaying titles must not redefine an explicit filename sort'
    )
  })

  it('sorts modification and creation timestamps independently', function () {
    const a = markdown('/notes/a.md', { modtime: 20, creationtime: 1 })
    const b = markdown('/notes/b.md', { modtime: 10, creationtime: 2 })
    const root = directory('/notes', 'modtime-up')

    assert.deepEqual(sortExplorerChildren(root, [a, b], DEFAULTS, [root]).map(x => x.name), [ 'b.md', 'a.md' ])
    root.settings.sorting = 'creationtime-down'
    assert.deepEqual(sortExplorerChildren(root, [a, b], DEFAULTS, [root]).map(x => x.name), [ 'b.md', 'a.md' ])
  })

  it('uses any scalar frontmatter field, including the Pandoc-ignored zettlr-order_ key', function () {
    const root = directory('/notes', 'frontmatter-up')
    const a = markdown('/notes/a.md', { frontmatter: { 'zettlr-order_': 20, date: '2026-09-10' } })
    const b = markdown('/notes/b.md', { frontmatter: { 'zettlr-order_': 10, date: '2026-09-12' } })
    const c = markdown('/notes/c.md')

    assert.deepEqual(
      sortExplorerChildren(root, [a, c, b], DEFAULTS, [root]).map(x => x.name),
      [ 'b.md', 'a.md', 'c.md' ],
      'manual order values are numeric and missing metadata stays last'
    )

    root.settings.explorer.sortMetadataKey = 'date'
    root.settings.sorting = 'frontmatter-down'
    assert.deepEqual(
      sortExplorerChildren(root, [a, c, b], DEFAULTS, [root]).map(x => x.name),
      [ 'b.md', 'a.md', 'c.md' ],
      'custom metadata fields support descending order without pulling missing values to the top'
    )
  })

  it('computes nested Project membership from project-relative paths rather than basenames', function () {
    const root = directory('/book', 'book-up', quartoProject([
      'beta/two.md',
      'alpha/one.md'
    ]))
    const roots: AnyDescriptor[] = [ root ]

    assert.deepEqual(projectMembershipForPath('/book/alpha/one.md', roots), {
      rootPath: '/book', manifestKind: 'quarto', status: 'included', position: 2
    })
    assert.deepEqual(projectMembershipForPath('/book/alpha/forgotten.md', roots), {
      rootPath: '/book', manifestKind: 'quarto', status: 'omitted'
    })
  })

  it('orders a filesystem tree by the earliest book chapter below each directory', function () {
    const root = directory('/book', 'book-up', quartoProject([
      'beta/two.md',
      'alpha/one.md'
    ]))
    const alpha = directory('/book/alpha')
    const beta = directory('/book/beta')
    const forgotten = markdown('/book/forgotten.md')

    assert.deepEqual(
      sortExplorerChildren(root, [alpha, forgotten, beta], DEFAULTS, [root]).map(x => x.name),
      [ 'beta', 'alpha', 'forgotten.md' ],
      'nested chapter order is visible without flattening away the filesystem hierarchy'
    )
  })

  it('filters files by Project membership while retaining directories as navigation routes', function () {
    const root = directory('/book', 'filename-up', quartoProject([ 'included.md', 'nested/included.md' ]))
    root.settings.explorer.projectFilter = 'omitted'
    const nested = directory('/book/nested')
    const included = markdown('/book/included.md')
    const omitted = markdown('/book/omitted.md')

    assert.deepEqual(
      sortExplorerChildren(root, [included, omitted, nested], DEFAULTS, [root]).map(x => x.name),
      [ 'nested', 'omitted.md' ]
    )
  })

  it('propagates explicit Project-root Explorer modes through nested chapter directories', function () {
    const root = directory('/book', 'book-up', quartoProject([
      'nested/z.md',
      'nested/a.md'
    ]))
    root.settings.explorer.displayName = 'filename'
    root.settings.explorer.projectFilter = 'included'
    const nested = directory('/book/nested', 'filename-up')
    const z = markdown('/book/nested/z.md', { title: 'A title' })
    const a = markdown('/book/nested/a.md', { title: 'Z title' })
    const omitted = markdown('/book/nested/m.md', { title: 'Middle' })

    assert.equal(effectiveExplorerDisplay(nested, DEFAULTS.fileNameDisplay), 'title+heading')
    assert.deepEqual(
      sortExplorerChildren(nested, [a, omitted, z], DEFAULTS, [root]).map(x => x.name),
      [ 'z.md', 'a.md' ],
      'book order and membership filtering come from the Project root, not each nested folder default'
    )
  })
})
