/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Hover Project-status red proofs (issue #1 Phase 7)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the Project-status row of the Phase-4 reference
 *                  hover tooltip: when the workspace reference view carries
 *                  projectRoots, the tooltip DOM contains an element whose
 *                  data-reference-project-status ATTRIBUTE VALUE is the
 *                  computed ProjectReferenceStatus literal and whose text is
 *                  the exact user-facing status wording. The active document
 *                  is the snapshot's own documentPath; the status follows the
 *                  computeProjectReferenceStatus contract. While projectRoots
 *                  is undefined the tooltip shows NO status element — it
 *                  never fabricates a membership.
 *
 *                  Follows the reference-hover.spec.ts harness: the
 *                  hoverTooltip source function is driven directly against a
 *                  real headless EditorView over the real fixture workspace
 *                  (ProjectB excluded so every hovered key resolves
 *                  uniquely).
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
import { referenceTooltip } from 'source/common/modules/markdown-editor/tooltips/references'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import {
  type DocumentReferenceSnapshot,
  type ProjectRootSpec
} from 'source/types/common/references'

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
const PROJECT_A = path.join(FIXTURE_ROOT, 'ProjectA')
const HALPHEN_PATH = path.join(PROJECT_A, 'Halphen_Surfaces.md')
const STANDALONE_PATH = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

/**
 * The single-project workspace (no ProjectB): every key defined in it is
 * unique, so every hovered occurrence resolves to exactly one definition.
 */
const RESOLVED_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  'Standalone_Notes.md',
]

const ALL_PROJECT_A_FILES = [ 'Theorems.md', 'Coble_Lattice_Table.md', 'Halphen_Surfaces.md' ]

function workspaceSnapshots (): DocumentReferenceSnapshot[] {
  return RESOLVED_FILES.map(relativePath => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath)
    return extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
  })
}

describe('Reference hover Project status (issue #1 Phase 7)', function () {
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

  /** An editor over `documentPath` whose reference view carries `projectRoots`. */
  function createEditor (documentPath: string, projectRoots: ProjectRootSpec[]|undefined): EditorView {
    const doc = readFileSync(documentPath, 'utf-8')
    const snapshots = workspaceSnapshots()
    const snapshot = snapshots.find(candidate => candidate.documentPath === documentPath)
    assert.ok(snapshot !== undefined, `the workspace must contain ${documentPath}`)
    const payload: EditorWorkspaceReferences = {
      snapshot,
      workspaceOccurrences: snapshots.flatMap(s => s.occurrences),
      resolutions: resolveWorkspace(snapshots),
      projectRoots
    }

    const state = EditorState.create({
      doc,
      extensions: [ markdownParser(), configField, workspaceReferencesField ]
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })
    views.push(view)
    return view
  }

  /** The rendered tooltip DOM for hovering `key` in the view's document. */
  function hoverDom (view: EditorView, key: string): HTMLElement {
    const references = view.state.field(workspaceReferencesField)
    assert.ok(references !== null, 'the workspace view must be present')
    const occurrence = references.snapshot.occurrences.find(o => o.key === key)
    assert.ok(occurrence !== undefined, `the document must contain an occurrence of ${key}`)
    const tooltip = referenceTooltip(view, occurrence.range.from + 1, 1)
    assert.ok(tooltip !== null, `hovering ${key} must answer a tooltip`)
    return tooltip.create(view).dom as HTMLElement
  }

  /** The tooltip's status element, asserting attribute value and wording. */
  function assertStatus (dom: HTMLElement, statusLiteral: string, wording: string): void {
    const status = dom.querySelector('[data-reference-project-status]')
    assert.ok(status !== null, 'the tooltip must contain the Project-status element')
    assert.strictEqual(status.getAttribute('data-reference-project-status'), statusLiteral)
    assert.strictEqual(status.textContent, wording)
  }

  it('shows In active Project for a target listed in the active root', function () {
    // Active: Halphen (in ProjectA); target tbl:coble-lattices lives in the
    // listed Coble_Lattice_Table.md.
    const view = createEditor(HALPHEN_PATH, [ { rootPath: PROJECT_A, files: ALL_PROJECT_A_FILES } ])
    assertStatus(hoverDom(view, 'tbl:coble-lattices'), 'in-active-project', 'In active Project')
  })

  it('shows Omitted from active Project for an unlisted in-root target', function () {
    // Same scene, but ProjectA does not list Coble_Lattice_Table.md.
    const view = createEditor(HALPHEN_PATH, [
      { rootPath: PROJECT_A, files: [ 'Theorems.md', 'Halphen_Surfaces.md' ] }
    ])
    assertStatus(hoverDom(view, 'tbl:coble-lattices'), 'omitted-from-active-project', 'Omitted from active Project')
  })

  it('shows Another Project for a Project-rooted target hovered from a standalone document', function () {
    // Active: Standalone_Notes.md (outside every root); thm:torelli resolves
    // to ProjectA/Theorems.md.
    const view = createEditor(STANDALONE_PATH, [ { rootPath: PROJECT_A, files: ALL_PROJECT_A_FILES } ])
    assertStatus(hoverDom(view, 'thm:torelli'), 'another-project', 'Another Project')
  })

  it('shows Standalone document when no root contains the target', function () {
    const view = createEditor(HALPHEN_PATH, [])
    assertStatus(hoverDom(view, 'tbl:coble-lattices'), 'standalone', 'Standalone document')
  })

  it('shows no status element while projectRoots is undefined (never fabricates)', function () {
    const view = createEditor(HALPHEN_PATH, undefined)
    const dom = hoverDom(view, 'tbl:coble-lattices')
    assert.strictEqual(dom.querySelector('[data-reference-project-status]'), null)
    // The Phase-4 surface is otherwise intact.
    assert.ok(dom.querySelector('[data-reference-key]') !== null)
  })
})
