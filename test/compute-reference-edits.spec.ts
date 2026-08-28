/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace rename edit-computation specs (issue #1, Phase 6 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the pure previewReferenceRename() contract over the
 *                  real reference-workspace fixture: the complete, exactly
 *                  ranged edit set for renaming a key (every definition AND
 *                  every occurrence, bare and inside clusters, across every
 *                  document — including ALL definitions of a duplicated
 *                  key), the expectedSourceHash pinning, the inverse undo
 *                  edits, and the typed rejections (prefix/family
 *                  preservation, collision, malformed key, unknown key).
 *                  Rejections are values, never throws.
 *
 *                  DUPLICATE-RENAME SEMANTICS (pinned): thm:torelli is
 *                  defined in BOTH ProjectA/Theorems.md and
 *                  ProjectB/Other_Paper.md. Renaming it edits BOTH
 *                  definitions and every occurrence: the typed model
 *                  mandates that duplicates never silently select one
 *                  definition, and a rename touching only one duplicate
 *                  would both select one silently and split the key into a
 *                  resolved/missing pair the author never wrote. The rename
 *                  moves the whole key, preserving its diagnosed duplicate
 *                  state under the new name.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import {
  previewReferenceRename,
  type ReferenceRenamePreview
} from 'source/common/pandoc-util/compute-reference-edits'
import { extractReferences, hashDocumentSource } from 'source/common/pandoc-util/extract-references'
import type {
  DocumentReferenceSnapshot,
  WorkspaceReferenceEdit,
  WorkspaceTextEdit
} from '@dts/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const HALPHEN_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Halphen_Surfaces.md')
const COBLE_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Coble_Lattice_Table.md')
const OTHER_PAPER_PATH = path.join(FIXTURE_ROOT, 'ProjectB', 'Other_Paper.md')
const STANDALONE_PATH = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

const ALL_PATHS = [ THEOREMS_PATH, HALPHEN_PATH, COBLE_PATH, OTHER_PAPER_PATH, STANDALONE_PATH ]

const sources = new Map<string, string>(ALL_PATHS.map(p => [ p, readFileSync(p, 'utf-8') ]))

/** The merged workspace snapshots, produced by the real extractor. */
const snapshots: DocumentReferenceSnapshot[] = ALL_PATHS
  .map(p => extractReferences(p, sources.get(p) ?? ''))

/**
 * Test-local oracle for the renderer/disk application contract: applies a
 * document's WorkspaceTextEdits to its source (descending by range start so
 * earlier ranges stay valid).
 */
function applyEdits (source: string, edits: WorkspaceTextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.range.from - a.range.from)
  let result = source
  for (const edit of ordered) {
    result = result.slice(0, edit.range.from) + edit.insert + result.slice(edit.range.to)
  }
  return result
}

/** Narrows an accepted preview to its edit, failing loudly on rejection. */
function editOf (preview: ReferenceRenamePreview, label: string): WorkspaceReferenceEdit {
  assert.equal(
    preview.status,
    'ok',
    `${label}: the preview must be accepted, got ${JSON.stringify(preview)}`
  )
  return (preview as Extract<ReferenceRenamePreview, { status: 'ok' }>).edit
}

/** The exact range of `token`'s single authored occurrence in a document. */
function tokenRange (documentPath: string, token: string): { from: number, to: number } {
  const source = sources.get(documentPath)
  assert.ok(source !== undefined, `unknown fixture document ${documentPath}`)
  const from = source.indexOf(token)
  assert.ok(from >= 0, `the fixture ${documentPath} must author ${token}`)
  assert.equal(
    source.indexOf(token, from + 1),
    -1,
    `${token} must occur exactly once in ${documentPath} for an unambiguous oracle`
  )
  return { from, to: from + token.length }
}

describe('previewReferenceRename', function () {
  it('renames a duplicated key across every definition and occurrence with exact ranges', function () {
    const edit = editOf(
      previewReferenceRename(snapshots, 'thm:torelli', 'thm:torelli-enriques'),
      'thm:torelli -> thm:torelli-enriques'
    )

    // Independent index-of oracle: each token is authored exactly once per
    // document, so the exact ranges are recomputable from the raw fixture.
    const expectedEdits: WorkspaceTextEdit[] = [
      // Definition id tokens (including the '#' sigil) — BOTH duplicate
      // definitions are edited (pinned duplicate-rename semantics).
      { documentPath: THEOREMS_PATH, range: tokenRange(THEOREMS_PATH, '#thm:torelli'), insert: '#thm:torelli-enriques' },
      { documentPath: OTHER_PAPER_PATH, range: tokenRange(OTHER_PAPER_PATH, '#thm:torelli'), insert: '#thm:torelli-enriques' },
      // The occurrence inside the bracketed cluster (Halphen) and the bare
      // occurrence (Standalone), each spanning '@thm:torelli' with sigil.
      { documentPath: HALPHEN_PATH, range: tokenRange(HALPHEN_PATH, '@thm:torelli'), insert: '@thm:torelli-enriques' },
      { documentPath: STANDALONE_PATH, range: tokenRange(STANDALONE_PATH, '@thm:torelli'), insert: '@thm:torelli-enriques' }
    ]

    const byPath = (a: WorkspaceTextEdit, b: WorkspaceTextEdit): number => a.documentPath.localeCompare(b.documentPath)
    assert.deepEqual(
      [...edit.edits].sort(byPath),
      expectedEdits.sort(byPath),
      'the preview must contain exactly the four token replacements'
    )

    // Cluster preservation: applying the Halphen edit rewrites only the key
    // token; punctuation and the sibling key survive byte-for-byte.
    const halphenApplied = applyEdits(
      sources.get(HALPHEN_PATH) ?? '',
      edit.edits.filter(e => e.documentPath === HALPHEN_PATH)
    )
    assert.ok(
      halphenApplied.includes('[@thm:torelli-enriques; @lem:embedding]'),
      'the bracketed cluster must keep its punctuation and sibling key'
    )

    const standaloneApplied = applyEdits(
      sources.get(STANDALONE_PATH) ?? '',
      edit.edits.filter(e => e.documentPath === STANDALONE_PATH)
    )
    assert.ok(
      standaloneApplied.includes('in @thm:torelli-enriques fails'),
      'the bare occurrence must be rewritten in place'
    )
  })

  it('pins expectedSourceHashes to the snapshot hashes of exactly the touched documents', function () {
    const edit = editOf(
      previewReferenceRename(snapshots, 'thm:torelli', 'thm:torelli-enriques'),
      'hash pinning'
    )

    assert.deepEqual(
      edit.expectedSourceHashes,
      {
        [THEOREMS_PATH]: hashDocumentSource(sources.get(THEOREMS_PATH) ?? ''),
        [OTHER_PAPER_PATH]: hashDocumentSource(sources.get(OTHER_PAPER_PATH) ?? ''),
        [HALPHEN_PATH]: hashDocumentSource(sources.get(HALPHEN_PATH) ?? ''),
        [STANDALONE_PATH]: hashDocumentSource(sources.get(STANDALONE_PATH) ?? '')
      },
      'exactly the four touched documents must be hash-fenced, at their previewed content'
    )
  })

  it('leaves buffer partitioning and conflict state to the committing layer', function () {
    const edit = editOf(
      previewReferenceRename(snapshots, 'thm:torelli', 'thm:torelli-enriques'),
      'partitioning'
    )

    // The pure preview computes per-document edits and hashes ONLY. Which
    // documents are open buffers vs closed files is the ReferenceProvider's
    // commit-time knowledge (it owns the live-overlay map), and conflicts
    // can only be discovered against commit-time reality.
    assert.deepEqual(edit.openBufferPaths, [], 'the pure preview never partitions open buffers')
    assert.deepEqual(edit.closedFilePaths, [], 'the pure preview never partitions closed files')
    assert.deepEqual(edit.conflict, { status: 'clean' }, 'a preview carries no conflict')
  })

  it('computes inverse undo edits restoring every touched document byte-exactly', function () {
    const edit = editOf(
      previewReferenceRename(snapshots, 'thm:torelli', 'thm:torelli-enriques'),
      'undo inversion'
    )

    for (const documentPath of [ THEOREMS_PATH, OTHER_PAPER_PATH, HALPHEN_PATH, STANDALONE_PATH ]) {
      const original = sources.get(documentPath) ?? ''
      const applied = applyEdits(original, edit.edits.filter(e => e.documentPath === documentPath))
      assert.notEqual(applied, original, `${documentPath}: the forward edits must actually change the document`)

      const restored = applyEdits(applied, edit.undo.filter(e => e.documentPath === documentPath))
      assert.equal(
        restored,
        original,
        `${documentPath}: applying undo after the forward edits must restore the original bytes`
      )
    }
  })

  it('renames a colon-bearing key without touching the prefix-similar occurrence', function () {
    // lem:kodaira:embedding keeps its inner colon; Halphen authors the
    // DIFFERENT key @lem:embedding, which must remain untouched.
    const edit = editOf(
      previewReferenceRename(snapshots, 'lem:kodaira:embedding', 'lem:kodaira-note'),
      'lem:kodaira:embedding -> lem:kodaira-note'
    )

    assert.deepEqual(
      edit.edits,
      [{
        documentPath: THEOREMS_PATH,
        range: tokenRange(THEOREMS_PATH, '#lem:kodaira:embedding'),
        insert: '#lem:kodaira-note'
      }],
      'only the single definition token may be edited; @lem:embedding is another key'
    )
    assert.deepEqual(
      Object.keys(edit.expectedSourceHashes),
      [THEOREMS_PATH],
      'only the defining document is touched, so only it is hash-fenced'
    )
  })

  it('rejects family changes as typed family-changed values', function () {
    const preview = previewReferenceRename(snapshots, 'thm:torelli', 'lem:torelli')
    assert.equal(preview.status, 'rejected', 'renames must preserve the family prefix')
    assert.deepEqual(
      preview.status === 'rejected' ? preview.reason : undefined,
      { kind: 'family-changed', oldFamily: 'thm', newFamily: 'lem' },
      'the rejection must name both families'
    )
  })

  it('rejects renaming onto an existing key as a collision naming every colliding definition', function () {
    // rmk:standalone-note is defined in Standalone_Notes.md.
    const collision = previewReferenceRename(snapshots, 'rmk:characteristic-two', 'rmk:standalone-note')
    assert.equal(collision.status, 'rejected')
    assert.deepEqual(
      collision.status === 'rejected' ? collision.reason : undefined,
      { kind: 'collision', newKey: 'rmk:standalone-note', definitionPaths: [STANDALONE_PATH] },
      'the collision must name the taken key and its defining document'
    )

    // Renaming a key onto itself collides with itself (never a silent
    // no-op); a duplicated key names every colliding definition.
    const selfRename = previewReferenceRename(snapshots, 'thm:torelli', 'thm:torelli')
    assert.equal(selfRename.status, 'rejected')
    const selfReason = selfRename.status === 'rejected' ? selfRename.reason : undefined
    assert.equal(selfReason?.kind, 'collision', 'a self-rename is a collision with itself')
    assert.deepEqual(
      selfReason?.kind === 'collision' ? [...selfReason.definitionPaths].sort() : undefined,
      [ THEOREMS_PATH, OTHER_PAPER_PATH ].sort(),
      'both duplicate definitions of thm:torelli collide'
    )
  })

  it('rejects structurally malformed replacement keys as typed malformed-key values', function () {
    const malformed = [
      '', // empty
      'thm:', // empty slug after the family
      'nonsense', // no colon at all
      'table:x', // unsupported family (near-miss of tbl:)
      'thm:bad key' // whitespace terminates the authored token
    ]
    for (const newKey of malformed) {
      const preview = previewReferenceRename(snapshots, 'thm:torelli', newKey)
      assert.equal(preview.status, 'rejected', `${JSON.stringify(newKey)} must be rejected`)
      assert.deepEqual(
        preview.status === 'rejected' ? preview.reason : undefined,
        { kind: 'malformed-key', newKey },
        `${JSON.stringify(newKey)} must be rejected as malformed, not laundered into another rejection`
      )
    }
  })

  it('distinguishes unknown-key rejection from a blanket rejection', function () {
    const unknown = previewReferenceRename(snapshots, 'thm:nonexistent', 'thm:fresh-slug')
    assert.deepEqual(
      unknown.status === 'rejected' ? unknown.reason : undefined,
      { kind: 'unknown-key', oldKey: 'thm:nonexistent' },
      'a key with no definition anywhere must be rejected as unknown'
    )

    // Discrimination guard: an implementation that rejects EVERYTHING as
    // unknown-key (e.g. the inert skeleton) must fail here — a known key
    // with an invalid replacement is a different rejection.
    const known = previewReferenceRename(snapshots, 'thm:torelli', 'lem:torelli')
    assert.equal(
      known.status === 'rejected' ? known.reason.kind : known.status,
      'family-changed',
      'a defined oldKey must never be reported as unknown'
    )
  })
})
