/**
 * @ignore
 * Contains: E2E and CodeMirror linter proof for Quarto theorem cross-references
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { referenceLintSource } from 'source/common/modules/markdown-editor/linters/reference-lint'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import type { DocumentReferenceSnapshot } from 'source/types/common/references'

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

describe('Quarto theorem cross-reference E2E and linter proof', function () {
  // Repo-owned fixtures (never the user's private research documents): a
  // classless Quarto ::: {#def-core} div whose title comes from its child
  // heading, and a separate document that cites @def-core.
  const FIXTURE_ROOT = path.resolve('test', 'fixtures', 'quarto-reference-e2e')
  const DEF_PATH = path.join(FIXTURE_ROOT, 'Definitions.md')
  const OCC_PATH = path.join(FIXTURE_ROOT, 'Consumers.md')

  let defText: string
  let occText: string
  const views: EditorView[] = []

  before(function () {
    polyfillJsdomForCodeMirror()
    defText = readFileSync(DEF_PATH, 'utf8')
    occText = readFileSync(OCC_PATH, 'utf8')
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (
    doc: string,
    activeSnap: DocumentReferenceSnapshot,
    workspace: DocumentReferenceSnapshot[]
  ): EditorView {
    const payload: EditorWorkspaceReferences = {
      snapshot: activeSnap,
      workspaceOccurrences: workspace.flatMap(s => s.occurrences),
      resolutions: resolveWorkspace(workspace),
      projectRoots: [{ rootPath: FIXTURE_ROOT, files: workspace.map(s => s.documentPath) }]
    }

    const state = EditorState.create({
      doc,
      extensions: [
        markdownParser(),
        configField,
        workspaceReferencesField
      ]
    })

    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state, parent })
    views.push(view)
    forceParsing(view, doc.length)
    view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })
    return view
  }

  it('extracts classless Quarto ::: {#def-core} as a theorem definition with child heading title', function () {
    const defSnap = extractReferences(DEF_PATH, defText)
    const defCore = defSnap.definitions.find(d => d.key === 'def-core')

    assert.ok(defCore !== undefined, 'def-core definition must be extracted')
    assert.strictEqual(defCore.key, 'def-core')
    assert.strictEqual(defCore.family, 'def')
    assert.strictEqual(defCore.sourceKind, 'theorem-div')
    assert.strictEqual(defCore.title, 'Underlying homotopy type and core')
  })

  it('extracts @def-core occurrence from consuming document', function () {
    const occSnap = extractReferences(OCC_PATH, occText)
    const occCore = occSnap.occurrences.filter(o => o.key === 'def-core')

    assert.ok(occCore.length > 0, '@def-core occurrence must be extracted')
    assert.strictEqual(occCore[0].key, 'def-core')
    assert.strictEqual(occCore[0].family, 'def')
  })

  it('resolves def-core end-to-end across workspace snapshots', function () {
    const defSnap = extractReferences(DEF_PATH, defText)
    const occSnap = extractReferences(OCC_PATH, occText)
    const resolutions = resolveWorkspace([defSnap, occSnap])

    const resolution = resolutions.get('def-core')
    assert.ok(resolution !== undefined, 'Resolution must exist for def-core')
    assert.strictEqual(resolution.status, 'resolved')
    if (resolution.status === 'resolved') {
      assert.strictEqual(resolution.definition.documentPath, DEF_PATH)
      assert.strictEqual(resolution.definition.title, 'Underlying homotopy type and core')
    }
  })

  it('CodeMirror reference linter produces ZERO missing-reference warnings for @def-core on active EditorView', async function () {
    const defSnap = extractReferences(DEF_PATH, defText)
    const occSnap = extractReferences(OCC_PATH, occText)
    const view = createEditor(occText, occSnap, [defSnap, occSnap])

    const diagnostics = await referenceLintSource(view)
    const defCoreDiagnostics = diagnostics.filter(d => d.message.includes('def-core'))

    assert.strictEqual(
      defCoreDiagnostics.length,
      0,
      `Expected 0 diagnostics for @def-core, but got: ${JSON.stringify(defCoreDiagnostics)}`
    )
  })

  it('CodeMirror reference linter DOES emit missing-key warning when def-core definition is absent', async function () {
    const occSnap = extractReferences(OCC_PATH, occText)
    // Only occurrence snapshot without the defining snapshot:
    const view = createEditor(occText, occSnap, [occSnap])

    const diagnostics = await referenceLintSource(view)
    const defCoreDiagnostics = diagnostics.filter(d => d.message.includes('def-core'))

    assert.ok(defCoreDiagnostics.length > 0, 'Expected missing-key diagnostic when definition is absent')
    assert.strictEqual(defCoreDiagnostics[0].severity, 'warning')
    assert.strictEqual(
      defCoreDiagnostics[0].message,
      'The reference "@def-core" is not defined anywhere in the workspace.'
    )
  })
})
