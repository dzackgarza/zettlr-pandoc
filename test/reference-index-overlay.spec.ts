/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference index overlay-authority specs (issue #1, red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves the overlay authority rule of the workspace
 *                  reference index: a reported live buffer replaces the saved
 *                  FSAL snapshot for its document and stays authoritative
 *                  until FSAL reports a saved snapshot whose sourceHash
 *                  exactly equals the live one's with no newer generation
 *                  reported since. Stale FSAL events never evict, out-of-order
 *                  live reports are ignored, drops revert to saved, unlinks
 *                  remove saved state but never an open buffer's overlay, and
 *                  resolutions are always recomputed over the merged view.
 *
 * END HEADER
 */

import assert from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { ReferenceIndex } from 'source/app/service-providers/references/reference-index'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import type { DocumentReferenceSnapshot, Resolution } from 'source/types/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')

const HALPHEN = path.join(FIXTURE_ROOT, 'ProjectA', 'Halphen_Surfaces.md')
const COBLE = path.join(FIXTURE_ROOT, 'ProjectA', 'Coble_Lattice_Table.md')
const THEOREMS = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const STANDALONE = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

/** The saved snapshot of a fixture file, exactly as FSAL would extract it. */
function savedSnapshot (documentPath: string): DocumentReferenceSnapshot {
  return extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
}

/**
 * A live-buffer snapshot of a fixture document whose unsaved content is the
 * saved content transformed by `transform` (identity transform = the unsaved
 * buffer exactly matches the disk content, so both hashes agree).
 */
function liveSnapshot (documentPath: string, transform: (content: string) => string = c => c): DocumentReferenceSnapshot {
  return extractReferences(documentPath, transform(readFileSync(documentPath, 'utf-8')))
}

/** The single merged snapshot served for a document; asserts it is present. */
function servedSnapshot (state: WorkspaceReferenceState, documentPath: string): DocumentReferenceSnapshot {
  const matches = state.snapshots.filter(snapshot => snapshot.documentPath === documentPath)
  assert.strictEqual(matches.length, 1, `the merged view must serve exactly one snapshot for ${documentPath}`)
  return matches[0]
}

/** The resolution served for a key; asserts it is present. */
function servedResolution (state: WorkspaceReferenceState, key: string): Resolution {
  const resolution = state.resolutions.get(key)
  assert.notStrictEqual(resolution, undefined, `the merged view must resolve the key ${key}`)
  return resolution as Resolution
}

describe('ReferenceIndex overlay authority', function () {
  it('serves every applied saved snapshot with resolutions over that view', function () {
    const index = new ReferenceIndex()
    const saved = [ savedSnapshot(HALPHEN), savedSnapshot(COBLE), savedSnapshot(THEOREMS) ]
    for (const snapshot of saved) {
      index.applySavedSnapshot(snapshot)
    }

    const state = index.getSnapshot()
    assert.strictEqual(state.snapshots.length, saved.length)
    for (const snapshot of saved) {
      assert.deepStrictEqual(servedSnapshot(state, snapshot.documentPath), snapshot)
    }
    assert.deepStrictEqual(state.resolutions, resolveWorkspace(saved))
  })

  it('replaces the saved snapshot with a reported live buffer in all outputs', function () {
    const index = new ReferenceIndex()
    const savedHalphen = savedSnapshot(HALPHEN)
    const savedCoble = savedSnapshot(COBLE)
    index.applySavedSnapshot(savedHalphen)
    index.applySavedSnapshot(savedCoble)

    const live = liveSnapshot(HALPHEN, content => content + '\nThe listing @lst:sage-run verifies the discriminant computation.\n')
    assert.notStrictEqual(live.sourceHash, savedHalphen.sourceHash)
    index.reportLiveBuffer(live, 1)

    const state = index.getSnapshot()
    assert.deepStrictEqual(servedSnapshot(state, HALPHEN), live)
    assert.deepStrictEqual(servedSnapshot(state, COBLE), savedCoble)
    assert.deepStrictEqual(state.resolutions, resolveWorkspace([ live, savedCoble ]))
  })

  it('evicts the overlay when FSAL reports the exact live hash with no newer generation', function () {
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(HALPHEN))

    const edit = (content: string): string => content + '\nAppended unsaved paragraph citing @sec:moduli.\n'
    index.reportLiveBuffer(liveSnapshot(HALPHEN, edit), 7)

    // The user saves: FSAL re-extracts the identical content, so the saved
    // hash exactly equals the live one and the overlay hands authority back.
    index.applySavedSnapshot(liveSnapshot(HALPHEN, edit))

    // Authority is back with FSAL: a later ordinary saved change (different
    // hash, no live buffer in play) must take effect immediately.
    const later = liveSnapshot(HALPHEN, content => content + '\nA later saved revision citing @tbl:coble-lattices.\n')
    index.applySavedSnapshot(later)

    assert.deepStrictEqual(servedSnapshot(index.getSnapshot(), HALPHEN), later)
  })

  it('keeps the overlay when a stale FSAL event reports a differing hash', function () {
    const index = new ReferenceIndex()
    const stale = savedSnapshot(HALPHEN)
    index.applySavedSnapshot(stale)

    const live = liveSnapshot(HALPHEN, content => content + '\nUnsaved sentence about @eq:intersection-form.\n')
    index.reportLiveBuffer(live, 3)

    // A stale watcher event re-reports the on-disk content, whose hash does
    // not match the live buffer: the overlay must survive.
    index.applySavedSnapshot(stale)

    assert.deepStrictEqual(servedSnapshot(index.getSnapshot(), HALPHEN), live)
  })

  it('ignores an out-of-order live report carrying an older generation', function () {
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(HALPHEN))

    const older = liveSnapshot(HALPHEN, content => content + '\nFirst unsaved draft citing @fig:root-diagram.\n')
    const newer = liveSnapshot(HALPHEN, content => content + '\nSecond unsaved draft citing @def:lattice.\n')
    index.reportLiveBuffer(newer, 12)
    index.reportLiveBuffer(older, 11)

    assert.deepStrictEqual(servedSnapshot(index.getSnapshot(), HALPHEN), newer)
  })

  it('does not evict on an exact hash match for a superseded generation', function () {
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(HALPHEN))

    const first = (content: string): string => content + '\nFirst draft citing @thm:torelli directly.\n'
    const second = (content: string): string => content + '\nSecond draft citing @lem:kodaira:embedding instead.\n'
    index.reportLiveBuffer(liveSnapshot(HALPHEN, first), 20)
    const currentLive = liveSnapshot(HALPHEN, second)
    index.reportLiveBuffer(currentLive, 21)

    // The save of the generation-20 content lands late: its hash matches an
    // outdated live report, not the current buffer, so the newer overlay
    // must remain authoritative.
    index.applySavedSnapshot(liveSnapshot(HALPHEN, first))

    assert.deepStrictEqual(servedSnapshot(index.getSnapshot(), HALPHEN), currentLive)
  })

  it('reverts to the saved snapshot when the live buffer is dropped', function () {
    const index = new ReferenceIndex()
    const saved = savedSnapshot(HALPHEN)
    index.applySavedSnapshot(saved)
    index.reportLiveBuffer(liveSnapshot(HALPHEN, content => content + '\nDiscarded draft citing @rmk:standalone-note.\n'), 5)

    index.dropLiveBuffer(HALPHEN)

    assert.deepStrictEqual(servedSnapshot(index.getSnapshot(), HALPHEN), saved)
  })

  it('removes an unlinked document without an overlay entirely', function () {
    const index = new ReferenceIndex()
    const savedCoble = savedSnapshot(COBLE)
    index.applySavedSnapshot(savedCoble)
    index.applySavedSnapshot(savedSnapshot(STANDALONE))

    index.removeSavedSnapshot(STANDALONE)

    const state = index.getSnapshot()
    assert.deepStrictEqual(state.snapshots, [savedCoble])
    // rmk:standalone-note was defined only in the removed document and is
    // referenced nowhere else, so it must vanish from the resolutions.
    assert.strictEqual(state.resolutions.get('rmk:standalone-note'), undefined)
  })

  it('follows a file move (unlink + add) to the new path without duplicating the definition (review C8)', function () {
    // A move arrives from FSAL as an unlink of the old path plus an add of
    // the same content under the new path. The index must end up serving
    // exactly one snapshot — under the new path — and resolve the moved
    // definition there, never as a duplicate and never as missing.
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(THEOREMS))
    index.applySavedSnapshot(savedSnapshot(HALPHEN)) // cites @thm:torelli

    const movedPath = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems_Renamed.md')
    index.removeSavedSnapshot(THEOREMS)
    index.applySavedSnapshot(extractReferences(movedPath, readFileSync(THEOREMS, 'utf-8')))

    const state = index.getSnapshot()
    assert.deepStrictEqual(
      state.snapshots.map(snapshot => snapshot.documentPath).sort(),
      [ HALPHEN, movedPath ].sort(),
      'the old path must vanish and the new path must serve the moved snapshot'
    )
    const resolution = servedResolution(state, 'thm:torelli')
    assert.strictEqual(resolution.status, 'resolved', 'the moved definition must resolve, not duplicate or go missing')
    if (resolution.status === 'resolved') {
      assert.strictEqual(resolution.definition.documentPath, movedPath, 'the resolution must point at the NEW path')
    }
  })

  it('keeps the live overlay of an unlinked but still open document', function () {
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(STANDALONE))
    const live = liveSnapshot(STANDALONE, content => content + '\nStill-open draft citing @thm:torelli again.\n')
    index.reportLiveBuffer(live, 2)

    index.removeSavedSnapshot(STANDALONE)

    assert.deepStrictEqual(servedSnapshot(index.getSnapshot(), STANDALONE), live)

    // Once the buffer closes too, nothing saved remains to revert to: the
    // document disappears from the merged view completely.
    index.dropLiveBuffer(STANDALONE)
    assert.deepStrictEqual(
      index.getSnapshot().snapshots.filter(snapshot => snapshot.documentPath === STANDALONE),
      []
    )
  })

  it('resolves a saved occurrence through a definition that exists only in a live buffer', function () {
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(HALPHEN))
    index.applySavedSnapshot(savedSnapshot(COBLE))

    // Saved-only baseline: the figure has never been drawn.
    assert.strictEqual(servedResolution(index.getSnapshot(), 'fig:nonexistent-diagram').status, 'missing')

    const live = liveSnapshot(COBLE, content => content + '\n![Semistable limit of the double fiber](limit.png){#fig:nonexistent-diagram}\n')
    index.reportLiveBuffer(live, 4)

    const resolution = servedResolution(index.getSnapshot(), 'fig:nonexistent-diagram')
    assert.strictEqual(resolution.status, 'resolved')
    assert.ok(resolution.status === 'resolved', 'narrowing')
    assert.strictEqual(resolution.definition.key, 'fig:nonexistent-diagram')
    assert.strictEqual(resolution.definition.documentPath, COBLE)
    assert.strictEqual(resolution.definition.sourceHash, live.sourceHash)
  })

  it('reports a duplicate introduced by a live overlay with every definition retained', function () {
    const index = new ReferenceIndex()
    index.applySavedSnapshot(savedSnapshot(THEOREMS))
    index.applySavedSnapshot(savedSnapshot(STANDALONE))

    // Saved-only baseline: the remark is defined once, in Theorems.md.
    assert.strictEqual(servedResolution(index.getSnapshot(), 'rmk:characteristic-two').status, 'resolved')

    const live = liveSnapshot(STANDALONE, content => content + '\n::: {.remark #rmk:characteristic-two}\nAn unsaved duplicate of the characteristic-two remark.\n:::\n')
    index.reportLiveBuffer(live, 9)

    const resolution = servedResolution(index.getSnapshot(), 'rmk:characteristic-two')
    assert.strictEqual(resolution.status, 'duplicate')
    assert.ok(resolution.status === 'duplicate', 'narrowing')
    assert.deepStrictEqual(
      resolution.definitions.map(definition => definition.documentPath).sort(),
      [ THEOREMS, STANDALONE ].sort()
    )
    assert.deepStrictEqual(resolution.definitions.map(definition => definition.key), [ 'rmk:characteristic-two', 'rmk:characteristic-two' ])
  })
})
