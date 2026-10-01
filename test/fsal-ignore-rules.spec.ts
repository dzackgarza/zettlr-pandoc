/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL ignore rule tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The FSAL lists a workspace through the ignore rules. These
 *                  tests read a real directory tree: what the two listings
 *                  return under a set of rules, and which paths enter and
 *                  leave the listing when the rules change.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import type { OtherFileDescriptor } from 'source/types/common/fsal'
import { createIgnoreFilter, type IgnoreFilter } from 'source/common/util/ignore-rules'
import {
  readDirectoryFromDisk,
  readDirectoryRecursivelyFromDisk,
  visibilityChanges
} from 'source/app/service-providers/fsal/util/read-directory'

const TREE = [
  'notes.md',
  'AGENTS.md',
  'scripts/plot.md',
  'coble/notes.md',
  'coble/AGENTS.md',
  'coble/scripts/run.md',
  'coble/Roadmap_files/figure.md',
  'coble/references/paper.md'
]

const logger = {
  error: (message: string): void => {
    throw new Error(message)
  }
}

async function getDescriptor (absPath: string): Promise<OtherFileDescriptor> {
  return {
    path: absPath,
    dir: path.dirname(absPath),
    name: path.basename(absPath),
    type: 'other',
    size: 0,
    modtime: 0,
    creationtime: 0,
    ext: path.extname(absPath)
  }
}

describe('FSAL listing under ignore rules', function () {
  let root: string

  const filterOf = (globalRules: string[], rulesFile = '', showIgnored = false): IgnoreFilter => {
    return createIgnoreFilter({ globalRules, workspaceRules: new Map([[ root, rulesFile ]]), showIgnored })
  }
  const relative = (paths: string[]): string[] => paths.map(absPath => path.relative(root, absPath)).sort()

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-fsal-ignore-'))
    for (const file of TREE) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), '# Text\n')
    }
  })

  afterEach(async function () {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists the whole tree without a rule', async function () {
    const listed = await readDirectoryRecursivelyFromDisk(root, { ignoreDotFiles: true, ignoreFilter: filterOf([]) }, logger)
    assert.deepEqual(relative(listed), [
      '',
      'AGENTS.md',
      'coble',
      'coble/AGENTS.md',
      'coble/Roadmap_files',
      'coble/Roadmap_files/figure.md',
      'coble/notes.md',
      'coble/references',
      'coble/references/paper.md',
      'coble/scripts',
      'coble/scripts/run.md',
      'notes.md',
      'scripts',
      'scripts/plot.md'
    ])
  })

  it('leaves the files and folders that a rule matches out of the recursive listing', async function () {
    const ignoreFilter = filterOf([ '*scripts*', '*_files/', 'references/', 'AGENTS.md' ])
    const listed = await readDirectoryRecursivelyFromDisk(root, { ignoreDotFiles: true, ignoreFilter }, logger)
    assert.deepEqual(relative(listed), [ '', 'coble', 'coble/notes.md', 'notes.md' ])
  })

  it('leaves them out of the listing of one directory', async function () {
    const ignoreFilter = filterOf([ '*_files/', 'AGENTS.md' ], '/coble/scripts/\nreferences/\n')
    const children = await readDirectoryFromDisk(
      path.join(root, 'coble'),
      { ignoreDotFiles: true, ignoreFilter },
      false,
      getDescriptor,
      logger
    )
    assert.deepEqual(relative(children.map(child => child.path)), ['coble/notes.md'])
  })

  it('lists every path while the reveal toggle is on', async function () {
    const ignoreFilter = filterOf([ '*scripts*', '*_files/', 'references/', 'AGENTS.md' ], '', true)
    const listed = await readDirectoryRecursivelyFromDisk(root, { ignoreDotFiles: true, ignoreFilter }, logger)
    assert.equal(listed.length, 14)
  })

  it('reports the paths a new rule hides, the content of a folder before the folder', async function () {
    const changes = await visibilityChanges(root, true, new Set(), filterOf([]), filterOf(['scripts/']), logger)
    assert.deepEqual(
      changes.map(change => [ path.relative(root, change.path), change.isDirectory, change.visible ]).sort(),
      [
        [ 'coble/scripts', true, false ],
        [ 'coble/scripts/run.md', false, false ],
        [ 'scripts', true, false ],
        [ 'scripts/plot.md', false, false ]
      ]
    )
    const order = changes.map(change => path.relative(root, change.path))
    assert.ok(order.indexOf('scripts/plot.md') < order.indexOf('scripts'))
    assert.ok(order.indexOf('coble/scripts/run.md') < order.indexOf('coble/scripts'))
  })

  it('reports the paths a removed rule shows again, a folder before its content', async function () {
    const changes = await visibilityChanges(root, true, new Set(), filterOf([ 'scripts/', 'AGENTS.md' ]), filterOf(['scripts/']), logger)
    assert.deepEqual(
      changes.map(change => [ path.relative(root, change.path), change.isDirectory, change.visible ]).sort(),
      [
        [ 'AGENTS.md', false, true ],
        [ 'coble/AGENTS.md', false, true ]
      ]
    )

    const shown = await visibilityChanges(root, true, new Set(), filterOf(['/coble/']), filterOf([]), logger)
    const order = shown.map(change => path.relative(root, change.path))
    assert.equal(order[0], 'coble')
    assert.equal(order.length, 9)
    assert.ok(shown.every(change => change.visible))
    assert.ok(order.indexOf('coble/scripts') < order.indexOf('coble/scripts/run.md'))
  })

  it('reports no change for a path below a folder that stays hidden', async function () {
    const changes = await visibilityChanges(root, true, new Set(), filterOf(['/coble/']), filterOf([ '/coble/', 'run.md' ]), logger)
    assert.deepEqual(changes, [])
  })

  it('reports no change for a folder that is an open workspace of its own', async function () {
    const inner = path.join(root, 'coble')
    const filterWith = (rulesFile: string): IgnoreFilter => createIgnoreFilter({
      globalRules: [],
      workspaceRules: new Map([[ root, rulesFile ], [ inner, '' ]]),
      showIgnored: false
    })
    const changes = await visibilityChanges(root, true, new Set([inner]), filterWith(''), filterWith('/coble/\n'), logger)
    assert.deepEqual(changes, [])
  })
})
