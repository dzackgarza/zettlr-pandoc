/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL deleted-directory regression tests
 * CVM-Role:        TESTING
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Proves stale explorer reads stay benign after a directory
 *                  and its descendants have been removed.
 *
 * END HEADER
 */

import assert from 'assert'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { readDirectoryFromDisk } from 'source/app/service-providers/fsal/util/read-directory'

const logger = { error: () => {} }
const getDescriptor = async (): Promise<never> => {
  throw new Error('An empty or deleted directory must not request child descriptors')
}

describe('FSAL directory reads after explorer deletion events', function () {
  let fixtureRoot: string

  beforeEach(async function () {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-fsal-delete-'))
  })

  afterEach(async function () {
    await fs.rm(fixtureRoot, { recursive: true, force: true })
  })

  it('returns an empty child list when the requested directory has just been deleted', async function () {
    const deletedDirectory = path.join(fixtureRoot, 'tmp')
    await fs.mkdir(deletedDirectory)
    await fs.rm(deletedDirectory, { recursive: true })

    assert.deepStrictEqual(
      await readDirectoryFromDisk(deletedDirectory, false, false, getDescriptor, logger),
      []
    )
  })

  it('settles every stale read after a recursive directory deletion', async function () {
    const deletedDirectory = path.join(fixtureRoot, 'tmp')
    const deletedDescendants = [
      deletedDirectory,
      path.join(deletedDirectory, 'preview-one'),
      path.join(deletedDirectory, 'preview-two'),
      path.join(deletedDirectory, 'test-clean')
    ]

    await Promise.all(deletedDescendants.slice(1).map(async directory => await fs.mkdir(directory, { recursive: true })))
    await fs.rm(deletedDirectory, { recursive: true })

    const results = await Promise.allSettled(
      deletedDescendants.map(async directory => await readDirectoryFromDisk(
        directory,
        false,
        false,
        getDescriptor,
        logger
      ))
    )

    assert.deepStrictEqual(
      results.map(result => result.status),
      deletedDescendants.map(() => 'fulfilled')
    )
    for (const result of results) {
      assert(result.status === 'fulfilled')
      assert.deepStrictEqual(result.value, [])
    }
  })

  it('still rejects an existing regular file as a directory', async function () {
    const regularFile = path.join(fixtureRoot, 'not-a-directory')
    await fs.writeFile(regularFile, 'content')

    await assert.rejects(
      async () => await readDirectoryFromDisk(regularFile, false, false, getDescriptor, logger),
      /Not a directory/
    )
  })

  it('still reads an existing empty directory', async function () {
    const emptyDirectory = path.join(fixtureRoot, 'empty')
    await fs.mkdir(emptyDirectory)

    assert.deepStrictEqual(
      await readDirectoryFromDisk(emptyDirectory, false, false, getDescriptor, logger),
      []
    )
  })
})
