/**
 * Mounts the production editor renderer for the Phase 5 reference navigation
 * Chromium probe (reference-navigation-probe.mjs). Follows the
 * editor-pandoc-div-click-entry.ts / editor-reference-chips-visual-entry.ts
 * pattern: real markdownParser, real chip renderers, the real
 * workspaceReferencesField fed by the REAL extractor over the fixture
 * documents, and the real production clickListeners() mousedown path.
 *
 * BOUNDARY SPLIT (issue #1 Phase 5, stated for the red constellation):
 *
 * - This probe owns the RENDERER half of Mod-click navigation: intent
 *   resolution at a real Chromium click coordinate
 *   (util/reference-navigation.ts resolveReferenceNavigationIntent),
 *   DocumentLocation capture at jump time (captureDocumentLocation),
 *   same-file follow via a selection dispatch in the SAME view, and — for
 *   cross-file jumps — the outgoing documents-provider 'open-file' request
 *   recorded at the window.ipc preload seam. The recorder is installed by
 *   the probe page BEFORE this bundle loads; it only records what the
 *   renderer sends and never simulates any documents-provider response or
 *   tab behavior.
 * - The MAIN-PROCESS half — per-pane widened history entries, tab
 *   reuse/opening, Back/Forward restoration — is owned by the real
 *   TabManager and locked red by test/tab-manager-history.spec.ts. The full
 *   cross-file tab choreography needs the real documents provider and is
 *   deliberately NOT faked here.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { codeFolding, foldEffect, foldedRanges } from '@codemirror/language'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { clickListeners } from 'source/common/modules/markdown-editor/plugins/click-listeners'
import { renderCitations } from 'source/common/modules/markdown-editor/renderers/render-citations'
import { renderReferenceChips } from 'source/common/modules/markdown-editor/renderers/render-reference-chips'
import { renderReferenceDefinitions } from 'source/common/modules/markdown-editor/renderers/render-reference-definitions'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import { defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import {
  captureDocumentLocation,
  followReferenceNavigationIntent,
  resolveReferenceNavigationIntent,
  type ReferenceNavigationIntent
} from 'source/common/modules/markdown-editor/util/reference-navigation'
import type { DocumentLocation, SourceRange } from '@dts/common/references'

interface ProbeDocument {
  path: string
  content: string
}

interface ProbeTarget {
  x: number
  y: number
  from: number
  to: number
}

interface ProbeSelection {
  anchor: number
  head: number
}

/**
 * The location expectation read independently from the live view at the same
 * instant a capture is requested. sourceGeneration is deliberately absent:
 * its exact value is the implementation's to define; the spec only requires
 * an integer on the captured side.
 */
interface ExpectedLocation {
  documentPath: string
  selection: ProbeSelection
  scrollTop: number
  folds: SourceRange[]
}

declare global {
  interface Window {
    __ipcInvocations: Array<{ channel: string, args: unknown[] }>
    refNavProbeMount: (documents: ProbeDocument[], scenePath: string) => Promise<{ mounted: boolean }>
    refNavProbeChipTarget: (key: string) => ProbeTarget | null
    refNavProbeTextTarget: (text: string) => ProbeTarget | null
    refNavProbeSelection: () => ProbeSelection
    refNavProbeHasVisibleText: (text: string) => boolean
    refNavProbeFold: (from: number, to: number) => void
    refNavProbeSetScrollTop: (px: number) => number
    refNavProbeExpectedLocation: () => ExpectedLocation
    refNavProbeCaptureLocation: () => DocumentLocation | null
    refNavProbeResolveIntentAt: (pos: number) => ReferenceNavigationIntent | null
    refNavProbeFollowIntent: (intent: ReferenceNavigationIntent) => boolean
    refNavProbeInvocations: () => Array<{ channel: string, args: unknown[] }>
    refNavProbePosAtCoords: (x: number, y: number) => number | null
  }
}

let view: EditorView | null = null
let currentDoc = ''
let currentPath = ''

function requireView (): EditorView {
  if (view === null) {
    throw new Error('reference-navigation probe view is not mounted')
  }
  return view
}

window.getCitationCallback = () => citations => citations.map(citation => {
  return [ citation.id, citation.locator, citation.suffix?.trimStart() ]
    .filter(part => part !== undefined)
    .join(' ')
}).join('; ')

function payloadFor (documents: ProbeDocument[], documentPath: string): EditorWorkspaceReferences {
  const workspace = documents.map(document => extractReferences(document.path, document.content))
  const snapshot = workspace.find(candidate => candidate.documentPath === documentPath)
  if (snapshot === undefined) {
    throw new Error(`Unknown probe scene document: ${documentPath}`)
  }
  return {
    snapshot,
    workspaceOccurrences: workspace.flatMap(candidate => candidate.occurrences),
    resolutions: resolveWorkspace(workspace)
  }
}

window.refNavProbeMount = async (documents: ProbeDocument[], scenePath: string) => {
  const sceneDocument = documents.find(document => document.path === scenePath)
  if (sceneDocument === undefined) {
    throw new Error(`The probe scene path is not among the delivered documents: ${scenePath}`)
  }

  view?.destroy()
  currentDoc = sceneDocument.content
  currentPath = sceneDocument.path

  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Reference navigation probe host is missing')
  }

  view = new EditorView({
    state: EditorState.create({
      doc: currentDoc,
      selection: { anchor: 0 },
      extensions: [
        markdownParser(),
        configField,
        // Fold substrate so the DocumentLocation capture scene can collapse
        // a real range (foldEffect needs the fold state field active).
        codeFolding(),
        EditorView.lineWrapping,
        editorTheme,
        defaultLight,
        renderCitations,
        renderReferenceChips,
        renderReferenceDefinitions,
        workspaceReferencesField,
        // The production Mod-click mousedown path under test, registered
        // exactly like table-editor/subview.ts registers it.
        EditorView.domEventHandlers(clickListeners())
      ]
    }),
    parent: host
  })
  view.dispatch({ effects: workspaceReferencesUpdate.of(payloadFor(documents, scenePath)) })

  view.focus()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  return { mounted: true }
}

function findVisibleTextNode (text: string): { node: Text, offset: number } | null {
  const host = document.querySelector('#editor')
  if (host === null) {
    return null
  }
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.textContent ?? ''
    const offset = value.indexOf(text)
    if (offset >= 0 && node instanceof Text) {
      return { node, offset }
    }
  }
  return null
}

window.refNavProbeTextTarget = (text: string): ProbeTarget | null => {
  const found = findVisibleTextNode(text)
  if (found === null) {
    return null
  }
  const range = document.createRange()
  range.setStart(found.node, found.offset)
  range.setEnd(found.node, found.offset + text.length)
  const rect = range.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const from = currentDoc.indexOf(text)
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    from,
    to: from + text.length
  }
}

window.refNavProbeChipTarget = (key: string): ProbeTarget | null => {
  const chip = document.querySelector<HTMLElement>(`.reference-chip[data-reference-key="${key}"]`)
  if (chip === null) {
    return null
  }
  const rect = chip.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const token = `@${key}`
  const from = currentDoc.indexOf(token)
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    from,
    to: from >= 0 ? from + token.length : -1
  }
}

window.refNavProbeSelection = (): ProbeSelection => {
  const main = requireView().state.selection.main
  return { anchor: main.anchor, head: main.head }
}

window.refNavProbeHasVisibleText = (text: string): boolean => {
  return findVisibleTextNode(text) !== null
}

window.refNavProbeFold = (from: number, to: number): void => {
  requireView().dispatch({ effects: foldEffect.of({ from, to }) })
}

window.refNavProbeSetScrollTop = (px: number): number => {
  const scroller = requireView().scrollDOM
  scroller.scrollTop = px
  return scroller.scrollTop
}

window.refNavProbeExpectedLocation = (): ExpectedLocation => {
  const liveView = requireView()
  const folds: SourceRange[] = []
  const iterator = foldedRanges(liveView.state).iter()
  while (iterator.value !== null) {
    folds.push({ from: iterator.from, to: iterator.to })
    iterator.next()
  }
  const main = liveView.state.selection.main
  return {
    documentPath: currentPath,
    selection: { anchor: main.anchor, head: main.head },
    scrollTop: liveView.scrollDOM.scrollTop,
    folds
  }
}

window.refNavProbeCaptureLocation = (): DocumentLocation | null => {
  return captureDocumentLocation(requireView(), currentPath)
}

window.refNavProbeResolveIntentAt = (pos: number): ReferenceNavigationIntent | null => {
  return resolveReferenceNavigationIntent(requireView(), pos)
}

window.refNavProbeFollowIntent = (intent: ReferenceNavigationIntent): boolean => {
  return followReferenceNavigationIntent(requireView(), intent)
}

window.refNavProbeInvocations = () => window.__ipcInvocations ?? []

window.refNavProbePosAtCoords = (x: number, y: number): number | null => {
  return requireView().posAtCoords({ x, y })
}
