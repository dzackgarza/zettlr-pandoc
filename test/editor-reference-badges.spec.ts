/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Definition badge red proofs (issue #1 Phase 4)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the definition-badge contract: every reference
 *                  definition in the current document carries a subtle label
 *                  badge plus a separate always-visible citing-count badge
 *                  (including zero), the count is the workspace-wide citing
 *                  occurrence count, and clicking the count badge emits the
 *                  same reference-search signal family as Mod-P, keyed to
 *                  that definition. Assertions target the badge DOM and the
 *                  emitted intent, never overlay internals.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderReferenceDefinitions } from 'source/common/modules/markdown-editor/renderers/render-reference-definitions'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import {
  openReferenceSearchEffect,
  type ReferenceSearchRequest
} from 'source/common/modules/markdown-editor/plugins/reference-search-effect'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import { type DocumentReferenceSnapshot } from 'source/types/common/references'

function polyfillJsdomForCodeMirror (): void {
  const w = globalThis as any
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    w.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (typeof w.window === 'object') {
      w.window.ResizeObserver = w.ResizeObserver
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }
}

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const WORKSPACE_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  'Standalone_Notes.md',
  path.join('ProjectB', 'Other_Paper.md'),
]

const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const COBLE_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Coble_Lattice_Table.md')

function workspaceSnapshots (): DocumentReferenceSnapshot[] {
  return WORKSPACE_FILES.map(relativePath => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath)
    return extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
  })
}

/** The typed editor payload for one open fixture document. */
function payloadFor (documentPath: string): { doc: string, payload: EditorWorkspaceReferences } {
  const doc = readFileSync(documentPath, 'utf-8')
  const snapshots = workspaceSnapshots()
  const snapshot = snapshots.find(candidate => candidate.documentPath === documentPath)
  assert.ok(snapshot !== undefined, `the fixture workspace must contain ${documentPath}`)
  return {
    doc,
    payload: {
      snapshot,
      workspaceOccurrences: snapshots.flatMap(s => s.occurrences),
      resolutions: resolveWorkspace(snapshots)
    }
  }
}

describe('Reference definition badges (issue #1 Phase 4)', function () {
  const views: EditorView[] = []

  before(function () {
    polyfillJsdomForCodeMirror()
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (documentPath: string, capturedRequests?: ReferenceSearchRequest[]): { view: EditorView, payload: EditorWorkspaceReferences } {
    const { doc, payload } = payloadFor(documentPath)
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdownParser(),
        configField,
        workspaceReferencesField,
        renderReferenceDefinitions,
        EditorView.updateListener.of(update => {
          if (capturedRequests === undefined) {
            return
          }
          for (const transaction of update.transactions) {
            for (const effect of transaction.effects) {
              if (effect.is(openReferenceSearchEffect)) {
                capturedRequests.push(effect.value)
              }
            }
          }
        }),
      ],
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })
    views.push(view)
    return { view, payload }
  }

  function labelBadges (view: EditorView): HTMLElement[] {
    return [ ...view.dom.querySelectorAll<HTMLElement>('.reference-definition-badge') ]
  }

  function countBadges (view: EditorView): HTMLElement[] {
    return [ ...view.dom.querySelectorAll<HTMLElement>('.reference-count-badge') ]
  }

  function countBadgeFor (view: EditorView, key: string): HTMLElement {
    const badge = view.dom.querySelector<HTMLElement>(`.reference-count-badge[data-reference-key="${key}"]`)
    assert.ok(badge !== null, `expected an always-visible count badge for ${key}`)
    return badge
  }

  it('renders one subtle label badge per definition, showing the authored key', function () {
    const { view, payload } = createEditor(THEOREMS_PATH)

    // Fixture invariant: the proof div, the empty-key near-miss, and the
    // unsupported table: prefix never become definitions.
    const keys = payload.snapshot.definitions.map(definition => definition.key)
    assert.strictEqual(keys.length, 15, 'the fixture must define one target per supported theorem family')
    assert.ok(!keys.includes('thm:should-not-index'), 'proof divs are never definitions')

    const badges = labelBadges(view)
    assert.deepStrictEqual(
      badges.map(badge => badge.dataset.referenceKey),
      keys,
      'every definition must carry exactly one label badge, in document order'
    )
    assert.deepStrictEqual(
      badges.map(badge => badge.textContent),
      keys,
      'the label badge shows the authored key'
    )
  })

  it('renders a separate always-visible count badge for every definition, including zero', function () {
    const { view, payload } = createEditor(THEOREMS_PATH)

    const badges = countBadges(view)
    assert.strictEqual(badges.length, payload.snapshot.definitions.length, 'every definition carries its own count badge, even at zero citing locations')

    // thm:torelli is cited twice across the workspace: once in the Halphen
    // cluster and once in the standalone notes.
    const torelli = countBadgeFor(view, 'thm:torelli')
    assert.strictEqual(torelli.dataset.citingCount, '2')
    assert.strictEqual(torelli.textContent, '2 references')

    // def:halphen-pencil is never cited anywhere: the badge must still be
    // present and must say so.
    const uncited = countBadgeFor(view, 'def:halphen-pencil')
    assert.strictEqual(uncited.dataset.citingCount, '0')
    assert.strictEqual(uncited.textContent, '0 references')
  })

  it('counts citing locations workspace-wide with a singular form for exactly one', function () {
    const { view } = createEditor(COBLE_PATH)

    // tbl:coble-lattices, eq:intersection-form, and sec:moduli are each
    // cited exactly once (all from Halphen_Surfaces.md); fig:root-diagram
    // and lst:sage-run are never cited.
    assert.strictEqual(countBadgeFor(view, 'tbl:coble-lattices').textContent, '1 reference')
    assert.strictEqual(countBadgeFor(view, 'eq:intersection-form').textContent, '1 reference')
    assert.strictEqual(countBadgeFor(view, 'sec:moduli').textContent, '1 reference')
    assert.strictEqual(countBadgeFor(view, 'fig:root-diagram').textContent, '0 references')
    assert.strictEqual(countBadgeFor(view, 'lst:sage-run').textContent, '0 references')
  })

  it('keeps the authored definition source intact next to its badges', function () {
    const { view } = createEditor(COBLE_PATH)

    assert.ok(countBadges(view).length > 0, 'the document must render count badges')
    // Badges decorate, they never replace: the authored id attributes stay
    // in the document text.
    assert.strictEqual(view.state.doc.toString(), readFileSync(COBLE_PATH, 'utf-8'))
    for (const badge of [ ...labelBadges(view), ...countBadges(view) ]) {
      assert.ok(!/\b(Theorem|Table|Figure|Equation|Section|Listing)\s+\d/.test(badge.textContent ?? ''), 'badges never display a computed reference number')
    }
  })

  it('emits the Mod-P signal family keyed to the definition when the count badge is clicked', function () {
    const captured: ReferenceSearchRequest[] = []
    const { view, payload } = createEditor(THEOREMS_PATH, captured)

    const torelli = countBadgeFor(view, 'thm:torelli')
    torelli.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    assert.deepStrictEqual(
      captured,
      [ {
        key: 'thm:torelli',
        occurrences: payload.workspaceOccurrences.filter(
          occurrence => occurrence.key === 'thm:torelli'
        )
      } ],
      'clicking the count badge must dispatch exactly one openReferenceSearchEffect keyed to the definition'
    )
    assert.strictEqual(torelli.dataset.citingCount, '2', 'the emitted intent belongs to the badge that shows the citing count')
  })
})
