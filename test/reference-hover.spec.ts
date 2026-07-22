/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference hover red proofs (issue #1 Phase 4)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the reference hover contract by driving the
 *                  hoverTooltip source function directly against a real
 *                  headless EditorView: a resolved supported-family
 *                  occurrence answers a tooltip spanning exactly the
 *                  authored `@key` token whose create() DOM presents type,
 *                  key, defining path, enclosing section, a bounded rendered
 *                  excerpt, and an expand action indicator. Bibliography
 *                  citations, plain prose, and unresolved occurrences answer
 *                  null — hover never fabricates a target.
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
const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const HALPHEN_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Halphen_Surfaces.md')

/**
 * The single-project workspace (no ProjectB): every key defined in it is
 * unique, so thm:torelli resolves to the ProjectA/Theorems.md definition.
 */
const RESOLVED_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  'Standalone_Notes.md',
]

function workspaceSnapshots (): DocumentReferenceSnapshot[] {
  return RESOLVED_FILES.map(relativePath => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath)
    return extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
  })
}

describe('Reference hover tooltips (issue #1 Phase 4)', function () {
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

  function createHalphenEditor (): { view: EditorView, doc: string } {
    const doc = readFileSync(HALPHEN_PATH, 'utf-8')
    const snapshots = workspaceSnapshots()
    const snapshot = snapshots.find(candidate => candidate.documentPath === HALPHEN_PATH)
    assert.ok(snapshot !== undefined, 'the workspace must contain the Halphen fixture')
    const payload: EditorWorkspaceReferences = {
      snapshot,
      workspaceOccurrences: snapshots.flatMap(s => s.occurrences),
      resolutions: resolveWorkspace(snapshots)
    }

    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [ markdownParser(), configField, workspaceReferencesField ],
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })
    views.push(view)
    return { view, doc }
  }

  it('answers a tooltip spanning exactly the authored @key token of a resolved occurrence', function () {
    const { view, doc } = createHalphenEditor()
    const token = '@thm:torelli'
    const from = doc.indexOf(token)
    assert.ok(from > 0, 'the fixture must cite thm:torelli')

    const tooltip = referenceTooltip(view, from + 3, 1)
    assert.ok(tooltip !== null, 'a resolved supported-family occurrence must produce a hover tooltip')
    assert.strictEqual(tooltip.pos, from)
    assert.strictEqual(tooltip.end, from + token.length)
  })

  it('presents type, key, path, and enclosing section of the resolved definition', function () {
    const { view, doc } = createHalphenEditor()
    const from = doc.indexOf('@thm:torelli')

    const tooltip = referenceTooltip(view, from + 3, 1)
    assert.ok(tooltip !== null, 'a resolved supported-family occurrence must produce a hover tooltip')
    const { dom } = tooltip.create(view)

    assert.strictEqual(dom.querySelector<HTMLElement>('[data-reference-type]')?.textContent, 'Theorem')
    assert.strictEqual(dom.querySelector<HTMLElement>('[data-reference-key]')?.textContent, 'thm:torelli')
    assert.strictEqual(dom.querySelector<HTMLElement>('[data-reference-path]')?.textContent, THEOREMS_PATH)
    assert.strictEqual(dom.querySelector<HTMLElement>('[data-reference-section]')?.textContent, 'Main results')
  })

  it('presents a bounded rendered excerpt of the definition plus an expand indicator', function () {
    const { view, doc } = createHalphenEditor()
    const from = doc.indexOf('@thm:torelli')

    const tooltip = referenceTooltip(view, from + 3, 1)
    assert.ok(tooltip !== null, 'a resolved supported-family occurrence must produce a hover tooltip')
    const { dom } = tooltip.create(view)

    const excerpt = dom.querySelector<HTMLElement>('[data-reference-excerpt]')
    assert.ok(excerpt !== null, 'the tooltip must carry the rendered excerpt')
    const text = excerpt.textContent ?? ''
    assert.ok(text.includes('Two complex Enriques surfaces'), 'the excerpt renders the definition body')
    assert.ok(!text.includes(':::'), 'the excerpt is rendered, never raw fence source')
    assert.ok(!text.includes('Halphen pencil of index'), 'the excerpt is bounded to the hovered definition, never the whole defining document')
    assert.ok(!/\bTheorem\s+\d/.test(text), 'the excerpt never displays a computed reference number')

    assert.ok(dom.querySelector('[data-reference-expand]') !== null, 'the tooltip must present its expand action indicator')
  })

  it('answers null for a missing reference instead of fabricating a target', function () {
    const { view, doc } = createHalphenEditor()
    const from = doc.indexOf('@fig:nonexistent-diagram')
    assert.ok(from > 0, 'the fixture must cite a missing key')

    assert.strictEqual(referenceTooltip(view, from + 3, 1), null)
  })

  it('leaves bibliography citations to the citation tooltip', function () {
    const { view, doc } = createHalphenEditor()
    const from = doc.indexOf('@Ols04')
    assert.ok(from > 0, 'the fixture must contain a bibliography citation')

    assert.strictEqual(referenceTooltip(view, from + 2, 1), null)
  })

  it('answers null over plain prose', function () {
    const { view, doc } = createHalphenEditor()
    const from = doc.indexOf('Restricting')
    assert.ok(from > 0)

    assert.strictEqual(referenceTooltip(view, from + 2, 1), null)
  })
})
