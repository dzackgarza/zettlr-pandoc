/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        M10 lifecycle: close/reopen, anchor mapping, drift + Reattach, rename
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The M10 gate (plan section 4). Three of the plan's seven
 *                  decisive end-to-end journeys (section 9, journeys 1, 2, 6)
 *                  plus the milestone's fourth acceptance line ("a rename
 *                  carries the sidecar"), all driven through the real
 *                  boundary annotation-transitions.spec.ts and
 *                  collaboration-application-service.spec.ts already
 *                  establish for this application: a real
 *                  CollaborationApplicationService, a real temporary sidecar
 *                  directory on disk, and DocumentAuthority — the smallest
 *                  complete implementation of the authority interface
 *                  DocumentManager itself satisfies in production, not a
 *                  stand-in for it.
 *
 *                  Journey 1 proves the sidecar is what a reopen actually
 *                  reads from, not memory that merely survived. Journey 2
 *                  proves the anchor mapper holds under BOTH a shift before
 *                  the target and an expansion inside it, in the same
 *                  document, back to back. Journey 6 proves invariant I6 has
 *                  no back door: an orphaned anchor comes back to `range`
 *                  ONLY through the owner's explicit Reattach, carrying a
 *                  range the owner picked. The rename spec proves the sidecar
 *                  key — a hash of the document path — moves with the file
 *                  instead of stranding the app-data file under its old name.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import type { CollaborationApplicationService } from 'source/app/service-providers/documents/document-collaboration-application-service'
import type { TextAnnotation } from '@dts/common/annotation-domain'
import { committed, harness as sharedHarness, reopened as sharedReopened, type Harness } from './collaboration-test-authority'

const DOCUMENT_ID = 'doc-lifecycle'
const DOCUMENT_PATH = '/tmp/annotation-lifecycle-note.md'
const BASELINE = 'The quick brown fox\njumps over the lazy dog\n'
/** "brown fox" — the stretch every journey below comments on. */
const TARGET = { from: 10, to: 19 }
const INSTRUCTION = 'Say what kind of fox this is.'

function harness (options: { diskText?: string, sidecarDirectory?: string } = {}): Harness {
  return sharedHarness({
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    tmpPrefix: 'zettlr-annotation-restart-',
    diskText: BASELINE,
    ...options
  })
}

/** A second process over the same sidecar directory: a real app restart. */
function reopened (options: { sidecarDirectory: string, diskText: string }): Harness {
  return sharedReopened({
    documentId: DOCUMENT_ID,
    documentPath: DOCUMENT_PATH,
    ...options
  })
}

async function createOne (
  service: CollaborationApplicationService,
  overrides: Partial<{ from: number, to: number, instruction: string, generation: number }> = {}
): Promise<TextAnnotation> {
  return committed(
    await service.createAnnotation({
      documentId: DOCUMENT_ID,
      actor: 'owner',
      from: overrides.from ?? TARGET.from,
      to: overrides.to ?? TARGET.to,
      instruction: overrides.instruction ?? INSTRUCTION,
      expectedAnnotationGeneration: overrides.generation ?? 0
    })
  )
}

describe('Journey 1 — create, close, reopen (plan section 9)', function () {
  it('restores the exact anchor coordinates and the full message thread from the v5 sidecar', async function () {
    const { service, authority, sidecarDirectory } = harness()
    const created = await createOne(service)
    const reply = committed(
      await service.addAnnotationMessage({
        documentId: DOCUMENT_ID,
        annotationId: created.annotationId,
        actor: 'agent',
        clientRequestId: 'reply-journey-1',
        text: 'It is a red fox.',
        expectedAnnotationGeneration: 1
      })
    )

    // Close: the document leaves memory. Nothing here re-derives state —
    // the mutations above were already on disk before this call returned.
    await service.detachCollaboration(DOCUMENT_ID)
    assert.equal(service.getAnnotations(DOCUMENT_ID).items.length, 0, 'closing must drop the in-memory state')
    authority.close()

    // Reopen the SAME file in the SAME running app — the boundary a real
    // "close the tab, click the file again" gesture crosses.
    authority.reopen()
    const restored = await service.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, BASELINE)
    assert.ok(restored !== undefined)
    assert.equal(restored.annotations.items.length, 1)
    const reopenedAnnotation = restored.annotations.items[0]

    assert.equal(reopenedAnnotation.annotationId, created.annotationId)
    assert.deepEqual(reopenedAnnotation.anchor, {
      state: 'range',
      from: TARGET.from,
      to: TARGET.to,
      quotedText: 'brown fox'
    })
    assert.deepEqual(
      reopenedAnnotation.messages.map((message) => message.text),
      [INSTRUCTION, reply.text]
    )

    // The exact v5 sidecar this came from, not a reconstruction in memory.
    const persisted = await service.readSidecar(DOCUMENT_PATH)
    assert.equal(persisted?.version, 5)
    assert.deepEqual(persisted?.annotations.items, restored.annotations.items)

    // A second, independent process reading the same directory sees the
    // identical state — proving it is the sidecar carrying it, not this
    // service instance's memory.
    const restarted = reopened({ sidecarDirectory, diskText: BASELINE })
    const afterRestart = await restarted.service.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, BASELINE)
    assert.deepEqual(afterRestart?.annotations.items, restored.annotations.items)
  })
})

describe('Journey 2 — anchor mapping through owner typing (plan section 9)', function () {
  it('maps the anchor through a shift before the target and an expansion inside it, without drift', async function () {
    const { service, authority } = harness()
    const created = await createOne(service)

    // The owner types before the selection: the anchor must shift by
    // exactly the inserted length and land on the identical text.
    const before = authority.ownerEdit({ from: 0, to: 0, insert: 'Once upon a time. ' })
    await service.applyWorkingTextEdit(DOCUMENT_ID, before.nextText, before.changes, before.commit)
    const shifted = service.getAnnotations(DOCUMENT_ID).items[0]
    assert.equal(shifted.annotationId, created.annotationId)
    assert.equal(shifted.anchor.state, 'range')
    const shiftedFrom = (shifted.anchor as { from: number }).from
    const shiftedTo = (shifted.anchor as { to: number }).to
    assert.equal(before.nextText.slice(shiftedFrom, shiftedTo), 'brown fox')
    assert.equal(shiftedFrom, before.nextText.indexOf('brown fox'))

    // Then the owner types INSIDE the selection: it must expand the range
    // rather than split it, drop it, or leave it stale.
    const insertionPoint = shiftedFrom + 'brown '.length
    const inside = authority.ownerEdit({ from: insertionPoint, to: insertionPoint, insert: 'red ' })
    await service.applyWorkingTextEdit(DOCUMENT_ID, inside.nextText, inside.changes, inside.commit)
    const expanded = service.getAnnotations(DOCUMENT_ID).items[0]
    assert.equal(expanded.anchor.state, 'range')
    const expandedFrom = (expanded.anchor as { from: number }).from
    const expandedTo = (expanded.anchor as { to: number }).to
    assert.equal(inside.nextText.slice(expandedFrom, expandedTo), 'brown red fox')
    assert.equal(expandedFrom, shiftedFrom, 'an interior insertion must not move the left boundary')
    assert.equal(expandedTo, shiftedTo + 'red '.length, 'an interior insertion must widen the right boundary by its length')
    // I1: quotedText is fixed at creation and never rewritten by a mapping.
    assert.equal(expanded.anchor.quotedText, 'brown fox')

    const persisted = await service.readSidecar(DOCUMENT_PATH)
    assert.deepEqual(persisted?.annotations.items[0].anchor, expanded.anchor)
  })
})

describe('Journey 6 — external disk drift then owner Reattach (plan section 9, invariant I6)', function () {
  it('orphans the annotation on drift, and returns it to range ONLY through an explicit owner Reattach', async function () {
    const { service, authority } = harness()
    const created = await createOne(service)
    await service.detachCollaboration(DOCUMENT_ID)
    authority.close()

    const drifted = 'Something else entirely.\nWritten by another program.\n'
    authority.setDiskText(drifted)
    authority.reopen()
    // The buffer reflects the drifted disk content, the way opening a file
    // that changed underneath the app does.
    authority.reloadFromDisk()

    const restored = await service.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, drifted)
    assert.ok(restored !== undefined)
    const orphaned = restored.annotations.items[0]
    assert.equal(orphaned.annotationId, created.annotationId)
    assert.deepEqual(orphaned.anchor, {
      state: 'orphaned',
      quotedText: 'brown fox',
      reason: 'external-drift'
    })
    // The thread survives the drift; only the anchor is lost (I6).
    assert.deepEqual(orphaned.messages.map((message) => message.text), [INSTRUCTION])

    // No heuristic recovery happens on its own: the anchor stays orphaned
    // until the owner acts, however long that takes.
    assert.equal(service.getAnnotations(DOCUMENT_ID).items[0].anchor.state, 'orphaned')

    // The owner selects a fresh range in the now-drifted document and clicks
    // Reattach — the ONLY path an anchor has back to `range` (I6: no fuzzy
    // or heuristic re-anchoring anywhere).
    const newQuote = 'another program'
    const newFrom = drifted.indexOf(newQuote)
    const newTo = newFrom + newQuote.length
    const reattached = committed(
      await service.reattachAnnotation({
        documentId: DOCUMENT_ID,
        annotationId: orphaned.annotationId,
        actor: 'owner',
        from: newFrom,
        to: newTo,
        expectedAnnotationGeneration: service.getAnnotations(DOCUMENT_ID).generation
      })
    )
    assert.deepEqual(reattached.anchor, {
      state: 'range',
      from: newFrom,
      to: newTo,
      // I1: the ORIGINAL quoted text survives the reattach untouched — the
      // card still shows what was actually commented on.
      quotedText: 'brown fox'
    })

    const persisted = await service.readSidecar(DOCUMENT_PATH)
    assert.deepEqual(persisted?.annotations.items[0].anchor, reattached.anchor)
  })

  it('refuses to reattach through anything but the owner (I3)', async function () {
    const { service, authority } = harness()
    const created = await createOne(service)
    await service.detachCollaboration(DOCUMENT_ID)
    authority.close()
    const drifted = 'Nothing here matches the original text.\n'
    authority.setDiskText(drifted)
    authority.reopen()
    authority.reloadFromDisk()
    await service.reattachCollaboration(DOCUMENT_ID, DOCUMENT_PATH, drifted)

    const refusal = await service.reattachAnnotation({
      documentId: DOCUMENT_ID,
      annotationId: created.annotationId,
      actor: 'agent',
      from: 0,
      to: 7,
      expectedAnnotationGeneration: service.getAnnotations(DOCUMENT_ID).generation
    })
    assert.ok('ok' in refusal && !refusal.ok, 'an agent must never move an anchor')
    assert.equal(service.getAnnotations(DOCUMENT_ID).items[0].anchor.state, 'orphaned')
  })
})

describe('Rename carries the sidecar (plan section 4, M10 acceptance)', function () {
  it('moves the sidecar to the new path\'s key, leaving no debris at the old one', async function () {
    const { service, sidecarDirectory } = harness()
    const created = await createOne(service)
    const newPath = '/tmp/annotation-lifecycle-note-renamed.md'

    await service.renameCollaboration(DOCUMENT_ID, DOCUMENT_PATH, newPath)

    assert.equal(
      await service.readSidecar(DOCUMENT_PATH),
      undefined,
      'no sidecar debris may survive at the old path'
    )
    const atNewPath = await service.readSidecar(newPath)
    assert.equal(atNewPath?.documentPath, newPath)
    assert.equal(atNewPath?.annotations.items[0]?.annotationId, created.annotationId)

    // The IN-MEMORY half moved too: detaching (which writes wherever the
    // service believes the document now lives) must not resurrect a file at
    // the old path.
    await service.detachCollaboration(DOCUMENT_ID)
    assert.equal(await service.readSidecar(DOCUMENT_PATH), undefined)
    assert.equal((await service.readSidecar(newPath))?.annotations.items[0]?.annotationId, created.annotationId)

    // A restart that only ever knew the NEW path must still find it — the
    // scenario "rename, then the app never reopens the old name again."
    const restarted = reopened({ sidecarDirectory, diskText: BASELINE })
    const afterRestart = await restarted.service.reattachCollaboration(DOCUMENT_ID, newPath, BASELINE)
    assert.equal(afterRestart?.annotations.items[0]?.annotationId, created.annotationId)
  })
})
