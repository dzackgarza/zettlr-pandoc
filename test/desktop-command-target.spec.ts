/** Pure target resolution for File-menu / command-launcher desktop actions. */

import { strict as assert } from 'assert'
import {
  resolveDirectoryHere,
  resolveExternalFile,
  type DesktopCommandContext,
  type DesktopPathDescriptor
} from 'source/win-main/util/desktop-command-target'

const workspace: DesktopPathDescriptor = {
  path: '/work/book', dir: '/work', type: 'directory'
}
const chapter: DesktopPathDescriptor = {
  path: '/work/book/chapter.md', dir: '/work/book', type: 'file'
}
const other: DesktopPathDescriptor = {
  path: '/work/book/other.md', dir: '/work/book', type: 'file'
}
const section: DesktopPathDescriptor = {
  path: '/work/book/sections', dir: '/work/book', type: 'directory'
}

function context (overrides: Partial<DesktopCommandContext> = {}): DesktopCommandContext {
  const descriptors = new Map<string, DesktopPathDescriptor>(
    [ workspace, chapter, other, section ].map(item => [ item.path, item ])
  )
  return {
    focusPath: undefined,
    activeFilePath: chapter.path,
    selectedDirectory: workspace.path,
    descriptors,
    roots: [ workspace ],
    ...overrides
  }
}

describe('desktop command target resolution', function () {
  it('uses a focused file ahead of the active editor file', function () {
    const ctx = context({ focusPath: other.path })
    assert.equal(resolveExternalFile(ctx), other.path)
    assert.equal(resolveDirectoryHere(ctx), other.dir)
  })

  it('uses a focused directory as here while keeping the active file for external editing', function () {
    const ctx = context({ focusPath: section.path })
    assert.equal(resolveExternalFile(ctx), chapter.path)
    assert.equal(resolveDirectoryHere(ctx), section.path)
  })

  it('falls back from focus to the active editor file', function () {
    const ctx = context({ focusPath: undefined })
    assert.equal(resolveExternalFile(ctx), chapter.path)
    assert.equal(resolveDirectoryHere(ctx), chapter.dir)
  })

  it('uses the selected Explorer directory when no file is active', function () {
    const ctx = context({ focusPath: undefined, activeFilePath: undefined })
    assert.equal(resolveExternalFile(ctx), undefined)
    assert.equal(resolveDirectoryHere(ctx), workspace.path)
  })

  it('uses one unambiguous root when there is no more specific context', function () {
    const ctx = context({ focusPath: undefined, activeFilePath: undefined, selectedDirectory: null })
    assert.equal(resolveDirectoryHere(ctx), workspace.path)
  })

  it('does not guess between multiple roots', function () {
    const second: DesktopPathDescriptor = { path: '/work/notes', dir: '/work', type: 'directory' }
    const ctx = context({
      focusPath: undefined,
      activeFilePath: undefined,
      selectedDirectory: null,
      roots: [ workspace, second ]
    })
    assert.equal(resolveDirectoryHere(ctx), undefined)
  })
})
