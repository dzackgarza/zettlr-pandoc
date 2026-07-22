/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Combined @-symbol completion red proofs (issue #1 Phase 3)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the combined `@` completion surface contract: the
 *                  at-symbols provider must preserve bibliography citation
 *                  completion byte-identically (trigger surface, option list,
 *                  and applied insertion text) while appending typed workspace
 *                  reference label entries when a 'references' database has
 *                  been pushed.
 *
 *                  The differential drives two real headless EditorViews over
 *                  the same documents: one through the CURRENT first-match
 *                  dispatch ([codeBlocks, citations, files, headings, tags,
 *                  snippets]) and one through the combined dispatch with
 *                  atSymbols in the citations slot. The in-test dispatcher
 *                  replicates the production first-match loop of
 *                  autocomplete/index.ts; the shared forbidden-token gate is
 *                  unaffected by the provider swap and stays out of scope.
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
import { codeBlocks } from 'source/common/modules/markdown-editor/autocomplete/code-blocks'
import { files } from 'source/common/modules/markdown-editor/autocomplete/files'
import { headings } from 'source/common/modules/markdown-editor/autocomplete/headings'
import { tags } from 'source/common/modules/markdown-editor/autocomplete/tags'
import { snippets } from 'source/common/modules/markdown-editor/autocomplete/snippets'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { THEOREM_DIV_PREFIXES } from 'source/common/util/pandoc-quick-reference'
import { type ReferenceCompletionEntry } from 'source/types/common/references'

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
  { citekey: 'BHPV04', displayText: 'Barth, Hulek, Peters, Van de Ven — Compact complex surfaces' },
]

/** Today's production first-match provider order (autocomplete/index.ts). */
const CURRENT_DISPATCH: AutocompletePlugin[] = [ codeBlocks, citations, files, headings, tags, snippets ]
/** The Phase-3 dispatch: atSymbols replaces citations in the same slot. */
const COMBINED_DISPATCH: AutocompletePlugin[] = [ codeBlocks, atSymbols, files, headings, tags, snippets ]

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const WORKSPACE_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  'Standalone_Notes.md',
  path.join('ProjectB', 'Other_Paper.md'),
]

/** Every workspace definition as a typed 'references' database entry. */
function workspaceEntries (): ReferenceCompletionEntry[] {
  return WORKSPACE_FILES.flatMap(relativePath => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath)
    const snapshot = extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
    return snapshot.definitions.map(definition => ({
      key: definition.key,
      family: definition.family,
      title: definition.title,
      documentPath: definition.documentPath,
    }))
  })
}

const CROSSREF_DISPLAY: Record<string, string> = {
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  sec: 'Section',
  lst: 'Listing',
}

/** The family display name of a label entry ('thm' -> 'Theorem', …). */
function familyDisplay (family: string): string {
  const theoremClass = (THEOREM_DIV_PREFIXES as Record<string, string>)[family]
  if (theoremClass !== undefined) {
    return theoremClass.charAt(0).toUpperCase() + theoremClass.slice(1)
  }
  const crossref = CROSSREF_DISPLAY[family]
  assert.notStrictEqual(crossref, undefined, `unexpected reference family: ${family}`)
  return crossref
}

/** The locked `Type — title` display text of a label completion. */
function expectedDetail (entry: ReferenceCompletionEntry): string {
  return entry.title !== undefined
    ? `${familyDisplay(entry.family)} — ${entry.title}`
    : familyDisplay(entry.family)
}

interface CompletionSurface {
  from: number
  options: Completion[]
}

describe('Combined @-symbol completion surface (issue #1 Phase 3)', function () {
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

  function createEditor (providers: AutocompletePlugin[], doc: string, anchor: number): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdownParser(),
        configField,
        // Register exactly the state fields the production autocomplete
        // extension registers for these providers.
        providers.map(provider => provider.fields ?? []),
      ],
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    view.dispatch({ effects: citekeyUpdate.of(CITATION_DB) })
    views.push(view)
    return view
  }

  /**
   * Replicates the production first-match dispatch loop of
   * autocomplete/index.ts over the given provider order and returns the
   * completion surface at the view's cursor, or null when no provider
   * applies.
   */
  function completionSurface (providers: AutocompletePlugin[], view: EditorView): CompletionSurface | null {
    const pos = view.state.selection.main.head
    const ctx = new CompletionContext(view.state, pos, false)
    for (const provider of providers) {
      const result = provider.applies(ctx)
      if (result !== false) {
        const query = view.state.doc.sliceString(result, pos).toLowerCase()
        return { from: result, options: provider.entries(ctx, query) }
      }
    }
    return null
  }

  /** Applies one completion option through its own apply handler. */
  function applyCompletion (view: EditorView, surface: CompletionSurface, index: number): void {
    const option = surface.options[index]
    assert.strictEqual(typeof option.apply, 'function', 'completions on the @ surface apply through their handler')
    const apply = option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void
    apply(view, option, surface.from, view.state.selection.main.head)
  }

  describe('byte-identity differential against the citation provider', function () {
    // The context matrix is derived from citations.ts applies(): branch 1
    // fires for a line-start '@' with the cursor directly behind it; branch 2
    // fires when /(?<=[-[\s(])@[^[\]]*$/ matches the text before the cursor.
    // Rows with appliesToday=false document contexts BOTH surfaces must
    // reject (line-start '@' with a query has no [-[\s(] lookbehind char, and
    // an email-like in-word '@' follows a letter).
    const contextMatrix: Array<{ name: string, doc: string, anchor?: number, appliesToday: boolean }> = [
      { name: 'a line-start @ with the cursor directly behind it', doc: '@', anchor: 1, appliesToday: true },
      { name: 'a bare citation after a space', doc: 'See @Ols', appliesToday: true },
      { name: 'a bracketed citation', doc: 'See [@Ols', appliesToday: true },
      { name: 'a suppressed-author citation', doc: 'See [-@Ols', appliesToday: true },
      { name: 'a citation after an opening parenthesis', doc: '(@Ols', appliesToday: true },
      { name: 'a bracketed citation behind an authored prefix', doc: '[see @Ols', appliesToday: true },
      { name: 'a query that filters the citation database', doc: 'See @kod', appliesToday: true },
      { name: 'a database sorted by in-document citation usage', doc: 'We follow [@Kod63]. See @', appliesToday: true },
      { name: 'a line-start @ with a query (no citation context today)', doc: '@Ols', appliesToday: false },
      { name: 'an email-like in-word @ (no citation context today)', doc: 'mail dzackgarza@gmail', appliesToday: false },
    ]

    for (const { name, doc, anchor, appliesToday } of contextMatrix) {
      it(`preserves citation completion byte-identically for ${name}`, function () {
        const cursor = anchor ?? doc.length
        const currentView = createEditor(CURRENT_DISPATCH, doc, cursor)
        const combinedView = createEditor(COMBINED_DISPATCH, doc, cursor)

        const current = completionSurface(CURRENT_DISPATCH, currentView)
        const combined = completionSurface(COMBINED_DISPATCH, combinedView)

        // Keep the matrix honest about today's behavior before differencing.
        assert.strictEqual(current !== null, appliesToday, 'the matrix row must reflect the current citation trigger surface')
        assert.deepStrictEqual(combined, current)

        if (current === null || combined === null) {
          return // Both surfaces reject the context identically.
        }

        assert.ok(current.options.length > 0, 'the citation database must produce options in a citation context')
        applyCompletion(currentView, current, 0)
        applyCompletion(combinedView, combined, 0)
        assert.strictEqual(combinedView.state.doc.toString(), currentView.state.doc.toString())
        assert.strictEqual(combinedView.state.selection.main.anchor, currentView.state.selection.main.anchor)
      })
    }

    it('keeps the combined surface citation-only while no references DB has been pushed', function () {
      const doc = 'See [@Ols'
      const currentView = createEditor(CURRENT_DISPATCH, doc, doc.length)
      const combinedView = createEditor(COMBINED_DISPATCH, doc, doc.length)

      const current = completionSurface(CURRENT_DISPATCH, currentView)
      const combined = completionSurface(COMBINED_DISPATCH, combinedView)

      assert.notStrictEqual(current, null)
      assert.deepStrictEqual(combined, current)
      assert.deepStrictEqual(
        combined?.options.map(option => option.label),
        [ 'Ols04', 'Kod63', 'BHPV04' ]
      )
    })
  })

  describe('typed label entries from the references database', function () {
    it('appends typed label entries after the unchanged citation entries', function () {
      const doc = 'See @'
      const entries = workspaceEntries()
      assert.ok(entries.length >= 20, 'the fixture workspace must provide a representative definition set')

      const currentView = createEditor(CURRENT_DISPATCH, doc, doc.length)
      const combinedView = createEditor(COMBINED_DISPATCH, doc, doc.length)
      combinedView.dispatch({ effects: referencesUpdate.of(entries) })

      const current = completionSurface(CURRENT_DISPATCH, currentView)
      const combined = completionSurface(COMBINED_DISPATCH, combinedView)

      assert.notStrictEqual(current, null)
      assert.ok(combined !== null, 'the combined surface must apply in a citation context')

      // Citation preservation holds with a references DB present: the leading
      // options are exactly the citation surface, unchanged.
      const citationOptions = (current as CompletionSurface).options
      assert.deepStrictEqual(combined.options.slice(0, citationOptions.length), citationOptions)

      // Every workspace definition follows as a typed label entry, in fed
      // order, presenting the locked `Type — title` display text.
      assert.deepStrictEqual(
        combined.options.slice(citationOptions.length).map(option => [ option.label, option.detail ]),
        entries.map(entry => [ entry.key, expectedDetail(entry) ])
      )
    })

    it('filters label entries by the typed query alongside the citation filter', function () {
      const doc = 'See @thm'
      const view = createEditor(COMBINED_DISPATCH, doc, doc.length)
      view.dispatch({ effects: referencesUpdate.of(workspaceEntries()) })

      const combined = completionSurface(COMBINED_DISPATCH, view)
      assert.ok(combined !== null, 'the combined surface must apply in a citation context')
      // No citation matches 'thm'; both authored thm: definitions do, in fed
      // order (ProjectA before ProjectB).
      assert.deepStrictEqual(
        combined.options.map(option => [ option.label, option.detail ]),
        [
          [ 'thm:torelli', 'Theorem — Torelli for Enriques' ],
          [ 'thm:torelli', 'Theorem — Torelli for rational elliptic surfaces' ],
        ]
      )
    })

    it('inserts a label completion as bare @-key text', function () {
      const doc = 'See @thm'
      const view = createEditor(COMBINED_DISPATCH, doc, doc.length)
      view.dispatch({ effects: referencesUpdate.of(workspaceEntries()) })

      const combined = completionSurface(COMBINED_DISPATCH, view)
      assert.ok(combined !== null, 'the combined surface must apply in a citation context')
      assert.strictEqual(combined.options[0]?.label, 'thm:torelli')

      applyCompletion(view, combined, 0)
      // Label insertion never wraps brackets and never rewrites the authored
      // '@': the key replaces the typed query, nothing else.
      assert.strictEqual(view.state.doc.toString(), 'See @thm:torelli')
      assert.strictEqual(view.state.selection.main.anchor, view.state.doc.length)
    })

    it('inserts a label completion inside an authored bracket cluster without rewriting it', function () {
      const doc = 'See [@thm'
      const view = createEditor(COMBINED_DISPATCH, doc, doc.length)
      view.dispatch({ effects: referencesUpdate.of(workspaceEntries()) })

      const combined = completionSurface(COMBINED_DISPATCH, view)
      assert.ok(combined !== null, 'the combined surface must apply in a citation context')
      assert.strictEqual(combined.options[0]?.label, 'thm:torelli')

      applyCompletion(view, combined, 0)
      assert.strictEqual(view.state.doc.toString(), 'See [@thm:torelli')
      assert.strictEqual(view.state.selection.main.anchor, view.state.doc.length)
    })

    it('renders label entries without Project-status gating in Phase 3', function () {
      const doc = 'See @'
      // Decorate every entry with a Project status; none of them may gate,
      // reorder, or restyle the completion surface in Phase 3.
      const decorated = workspaceEntries().map(entry => ({
        ...entry,
        projectStatus: entry.documentPath.includes('ProjectB')
          ? 'another-project' as const
          : entry.documentPath.includes('ProjectA')
            ? 'in-active-project' as const
            : 'standalone' as const,
      }))

      const currentView = createEditor(CURRENT_DISPATCH, doc, doc.length)
      const combinedView = createEditor(COMBINED_DISPATCH, doc, doc.length)
      combinedView.dispatch({ effects: referencesUpdate.of(decorated) })

      const current = completionSurface(CURRENT_DISPATCH, currentView)
      const combined = completionSurface(COMBINED_DISPATCH, combinedView)
      assert.notStrictEqual(current, null)
      assert.ok(combined !== null, 'the combined surface must apply in a citation context')

      const citationOptions = (current as CompletionSurface).options
      assert.deepStrictEqual(
        combined.options.slice(citationOptions.length).map(option => [ option.label, option.detail ]),
        decorated.map(entry => [ entry.key, expectedDetail(entry) ])
      )
    })
  })
})
