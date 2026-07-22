/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Project-status completion gating red proofs (issue #1 Phase 7)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks how the combined `@` completion surface consumes
 *                  status-carrying ReferenceCompletionEntry values (Phase 7):
 *
 *                  - Entries stay VISIBLE with unchanged label/detail text
 *                    regardless of projectStatus (the Phase-3 presentation
 *                    contract is preserved).
 *                  - Every label option exposes its typed insertion
 *                    affordance as `referenceAffordance` (the decision table
 *                    of completionAffordanceFor).
 *                  - Applying an 'another-project' option leaves the
 *                    document unchanged: those targets are visible but
 *                    DISABLED for insertion.
 *                  - Applying an omitted-from-active-Project option still
 *                    inserts the bare key; the option carries the
 *                    append-and-continue plan so the renderer can run the
 *                    mechanical append through the existing
 *                    'update-project-properties' surface.
 *                  - Standalone options insert and carry the export-unit
 *                    warning affordance.
 *                  - Citation options are byte-identical to the citation
 *                    provider and never carry a referenceAffordance.
 *
 *                  The statuses are INPUT here (attached to the entries as
 *                  the provider-side annotation produces them); computing
 *                  them is locked by test/project-reference-status.spec.ts.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { type AutocompletePlugin } from 'source/common/modules/markdown-editor/autocomplete'
import { citations, citekeyUpdate } from 'source/common/modules/markdown-editor/autocomplete/citations'
import { atSymbols, referencesUpdate } from 'source/common/modules/markdown-editor/autocomplete/at-symbols'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { type CompletionInsertionAffordance } from 'source/common/pandoc-util/project-reference-status'
import {
  type AppendAndContinuePlan,
  type ProjectReferenceStatus,
  type ReferenceCompletionEntry
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

/** A representative bibliography database, as MainEditor.vue would push it. */
const CITATION_DB = [
  { citekey: 'Ols04', displayText: 'Olsson — Semistable degenerations and period spaces for polarized K3 surfaces' },
  { citekey: 'Kod63', displayText: 'Kodaira — On compact analytic surfaces II' },
]

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const PROJECT_A = path.join(FIXTURE_ROOT, 'ProjectA')
const THEOREMS = path.join(PROJECT_A, 'Theorems.md')
const COBLE = path.join(PROJECT_A, 'Coble_Lattice_Table.md')
const OTHER_PAPER = path.join(FIXTURE_ROOT, 'ProjectB', 'Other_Paper.md')
const STANDALONE = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

const COBLE_APPEND_PLAN: AppendAndContinuePlan = {
  rootPath: PROJECT_A,
  appendFiles: [ 'Coble_Lattice_Table.md' ]
}

/**
 * The annotated Phase-7 completion database: every real fixture definition,
 * carrying the status the provider-side annotation computes for the scene
 * "active document Halphen_Surfaces.md; ProjectA lists Theorems + Halphen".
 */
function annotatedEntries (): ReferenceCompletionEntry[] {
  const statusOf: Record<string, ProjectReferenceStatus> = {
    [THEOREMS]: 'in-active-project',
    [COBLE]: 'omitted-from-active-project',
    [OTHER_PAPER]: 'another-project',
    [STANDALONE]: 'standalone'
  }
  return [ THEOREMS, COBLE, OTHER_PAPER, STANDALONE ].flatMap(documentPath => {
    const snapshot = extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
    return snapshot.definitions.map(definition => ({
      key: definition.key,
      family: definition.family,
      title: definition.title,
      documentPath: definition.documentPath,
      projectStatus: statusOf[documentPath],
      appendPlan: documentPath === COBLE ? COBLE_APPEND_PLAN : undefined
    }))
  })
}

/** Reads the typed affordance a Phase-7 label option must expose. */
function affordanceOf (option: Completion): CompletionInsertionAffordance|undefined {
  return (option as { referenceAffordance?: CompletionInsertionAffordance }).referenceAffordance
}

describe('Project-status completion gating (issue #1 Phase 7)', function () {
  const views: EditorView[] = []

  /** Every renderer->main request recorded at the window.ipc preload seam. */
  interface RecordedInvoke { channel: string, message: { command: string, payload?: unknown } }
  const recordedInvokes: RecordedInvoke[] = []
  const windowWithIpc = window as unknown as { ipc?: { invoke: (channel: string, message: RecordedInvoke['message']) => Promise<unknown> } }
  let previousIpc: typeof windowWithIpc.ipc

  before(function () {
    polyfillJsdomForCodeMirror()
    // window.ipc is the production preload bridge, present in every renderer
    // window (review B9: no existence guard in at-symbols). The harness
    // provisions the same seam; get-descriptor answers with the REAL
    // ProjectA settings shape so the append continuation runs against the
    // exact dir-settings surface production consumes.
    previousIpc = windowWithIpc.ipc
    windowWithIpc.ipc = {
      invoke: async (channel, message) => {
        recordedInvokes.push({ channel, message })
        if (channel === 'fsal' && message.command === 'get-descriptor') {
          return {
            path: PROJECT_A,
            settings: {
              project: {
                title: 'Project A',
                profiles: [],
                filters: [],
                cslStyle: '',
                templates: { tex: '', html: '' },
                files: [ 'Theorems.md', 'Halphen_Surfaces.md' ]
              }
            }
          }
        }
        return undefined
      }
    }
  })

  after(function () {
    windowWithIpc.ipc = previousIpc
  })

  beforeEach(function () {
    recordedInvokes.splice(0)
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (doc: string, entries: ReferenceCompletionEntry[]): EditorView {
    const providers: AutocompletePlugin[] = [atSymbols]
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownParser(),
        configField,
        providers.map(provider => provider.fields ?? []),
      ],
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    view.dispatch({ effects: citekeyUpdate.of(CITATION_DB) })
    view.dispatch({ effects: referencesUpdate.of(entries) })
    views.push(view)
    return view
  }

  /** The combined surface at the view's cursor (atSymbols must apply). */
  function surfaceAt (view: EditorView): { from: number, options: Completion[] } {
    const pos = view.state.selection.main.head
    const ctx = new CompletionContext(view.state, pos, false)
    const from = atSymbols.applies(ctx)
    assert.notStrictEqual(from, false, 'the combined surface must apply in a citation context')
    const query = view.state.doc.sliceString(from as number, pos).toLowerCase()
    return { from: from as number, options: atSymbols.entries(ctx, query) }
  }

  /** The single label option for `key` on the surface. */
  function optionFor (view: EditorView, key: string): { surface: { from: number, options: Completion[] }, option: Completion } {
    const surface = surfaceAt(view)
    const matches = surface.options.filter(option => option.label === key)
    assert.strictEqual(matches.length, 1, `exactly one label option for ${key}`)
    return { surface, option: matches[0] }
  }

  /** Lets the fire-and-forget append continuation drain (two awaits). */
  async function waitForAppend (): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  /** Applies one option through its own apply handler. */
  function applyOption (view: EditorView, surface: { from: number }, option: Completion): void {
    assert.strictEqual(typeof option.apply, 'function', 'label options apply through their handler')
    const apply = option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void
    apply(view, option, surface.from, view.state.selection.main.head)
  }

  it('keeps status-carrying entries visible with unchanged label/detail text', function () {
    const entries = annotatedEntries()
    const view = createEditor('See @', entries)
    const bare = createEditor('See @', entries.map(entry => ({
      key: entry.key,
      family: entry.family,
      title: entry.title,
      documentPath: entry.documentPath
    })))

    const decorated = surfaceAt(view)
    const undecorated = surfaceAt(bare)
    assert.deepStrictEqual(
      decorated.options.map(option => [ option.label, option.detail ]),
      undecorated.options.map(option => [ option.label, option.detail ])
    )
  })

  it('disables insertion for another-Project entries while keeping them listed', function () {
    // def:lattice is defined only in ProjectB/Other_Paper.md.
    const view = createEditor('See @def', annotatedEntries())
    const { surface, option } = optionFor(view, 'def:lattice')

    assert.deepStrictEqual(affordanceOf(option), { kind: 'disabled-another-project' })

    applyOption(view, surface, option)
    // Disabled for insertion: the authored document is untouched.
    assert.strictEqual(view.state.doc.toString(), 'See @def')
  })

  it('inserts omitted entries and carries their append-and-continue plan', function () {
    // tbl:coble-lattices is defined in the omitted Coble_Lattice_Table.md.
    const view = createEditor('See @tbl', annotatedEntries())
    const { surface, option } = optionFor(view, 'tbl:coble-lattices')

    assert.deepStrictEqual(affordanceOf(option), {
      kind: 'insert-with-append',
      plan: COBLE_APPEND_PLAN
    })

    applyOption(view, surface, option)
    // Append-and-continue CONTINUES: the insertion itself is the unchanged
    // bare-key insertion.
    assert.strictEqual(view.state.doc.toString(), 'See @tbl:coble-lattices')

    // … and the mechanical append actually runs through the EXISTING
    // dir-settings surface (review B8/B9): the plan's root descriptor is
    // fetched and 'update-project-properties' receives the settings with
    // the omitted file appended — no new ipc channel, no dialog.
    return waitForAppend().then(() => {
      assert.deepStrictEqual(
        recordedInvokes.map(entry => [ entry.channel, entry.message.command ]),
        [
          [ 'fsal', 'get-descriptor' ],
          [ 'application', 'update-project-properties' ]
        ]
      )
      const update = recordedInvokes[1].message.payload as { path: string, properties: { files: string[] } }
      assert.strictEqual(update.path, PROJECT_A)
      assert.deepStrictEqual(
        update.properties.files,
        [ 'Theorems.md', 'Halphen_Surfaces.md', 'Coble_Lattice_Table.md' ],
        'the append plan must extend ProjectSettings.files with exactly the omitted target'
      )
    })
  })

  it('inserts standalone entries with the export-unit warning affordance', function () {
    // rmk:standalone-note is defined in Standalone_Notes.md.
    const view = createEditor('See @rmk', annotatedEntries())
    const { surface, option } = optionFor(view, 'rmk:standalone-note')

    assert.deepStrictEqual(affordanceOf(option), { kind: 'insert-with-export-warning' })

    applyOption(view, surface, option)
    assert.strictEqual(view.state.doc.toString(), 'See @rmk:standalone-note')
  })

  it('marks in-active-Project entries with the plain insert affordance', function () {
    // prop:fibration-count is defined in the listed Theorems.md.
    const view = createEditor('See @prop', annotatedEntries())
    const { surface, option } = optionFor(view, 'prop:fibration-count')

    assert.deepStrictEqual(affordanceOf(option), { kind: 'insert' })

    applyOption(view, surface, option)
    assert.strictEqual(view.state.doc.toString(), 'See @prop:fibration-count')
  })

  it('leaves citation options byte-identical and affordance-free', function () {
    const doc = 'See @'
    const view = createEditor(doc, annotatedEntries())
    const citationView = createEditor(doc, [])

    const pos = citationView.state.selection.main.head
    const ctx = new CompletionContext(citationView.state, pos, false)
    const from = citations.applies(ctx)
    assert.notStrictEqual(from, false)
    const citationOptions = citations.entries(ctx, citationView.state.doc.sliceString(from as number, pos).toLowerCase())

    const combined = surfaceAt(view)
    assert.deepStrictEqual(combined.options.slice(0, citationOptions.length), citationOptions)
    assert.ok(
      combined.options.slice(0, citationOptions.length).every(option => affordanceOf(option) === undefined),
      'citation options never carry a reference affordance'
    )
  })
})
