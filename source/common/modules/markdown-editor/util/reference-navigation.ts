/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference navigation utilities (issue #1 Phase 5 skeleton)
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The renderer-side reference navigation surface locked red
 *                  by test/reference-navigation.spec.ts. Phase 5 green work
 *                  implements these functions and wires them into the
 *                  Mod-click mousedown path of plugins/click-listeners.ts
 *                  (Citation nodes with supported-family keys, plus Footnote
 *                  nodes). Until then every function is intentionally inert:
 *                  it returns null / false and performs no navigation, so the
 *                  red specs fail on assertions against real behavior rather
 *                  than on crashes.
 *
 *                  Boundary split (stated once here, asserted in the specs):
 *                  this module owns the RENDERER half of navigation — intent
 *                  resolution at a click position, DocumentLocation capture
 *                  at jump time, same-file follow dispatch, and the outgoing
 *                  documents-provider 'open-file' request for cross-file
 *                  jumps. The MAIN-PROCESS half — per-pane history entries,
 *                  tab reuse/opening, and Back/Forward restoration — is owned
 *                  by the documents provider's TabManager and locked red by
 *                  test/tab-manager-history.spec.ts.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'
import type { DocumentLocation, ReferenceFamily, SourceRange } from '@dts/common/references'

/**
 * Whether a navigation stays inside the clicked document (same tab) or
 * targets another workspace document (reuse an existing tab or open one).
 */
export type ReferenceNavigationScope = 'same-file' | 'cross-file'

/**
 * The exact destination of one navigation: the defining document and the
 * range of the authored definition id token (for references) or of the
 * footnote ref body (for footnotes).
 */
export interface ReferenceNavigationTarget {
  documentPath: string
  range: SourceRange
}

/**
 * One resolved Mod-click navigation. `source` is the origin location
 * captured at jump time; Back must restore exactly this location.
 */
export interface ReferenceNavigationIntent {
  kind: 'reference' | 'footnote'
  scope: ReferenceNavigationScope
  /** The authored reference key ('thm:torelli') or footnote label ('[^note]') */
  key: string
  /** The supported reference family, or null for footnotes */
  family: ReferenceFamily | null
  target: ReferenceNavigationTarget
  source: DocumentLocation
}

/**
 * Captures the restorable location of the given view: primary selection,
 * viewport scroll position, collapsed fold ranges, and source generation.
 *
 * Phase 5 skeleton: returns null (capture not implemented).
 */
export function captureDocumentLocation (_view: EditorView, _documentPath: string): DocumentLocation | null {
  return null
}

/**
 * Resolves the reference or footnote navigation intent at the given document
 * position, using the syntax tree for the clicked node and the
 * workspaceReferencesField resolutions for the definition target. Returns
 * null when the position carries no supported navigation target.
 *
 * Phase 5 skeleton: always returns null (resolution not implemented).
 */
export function resolveReferenceNavigationIntent (_view: EditorView, _pos: number): ReferenceNavigationIntent | null {
  return null
}

/**
 * Follows a resolved navigation intent: same-file intents dispatch the
 * definition selection in the current view; cross-file intents send the
 * documents-provider 'open-file' request carrying the target range and the
 * captured source location. Returns true when the intent was followed.
 *
 * Phase 5 skeleton: performs nothing and returns false.
 */
export function followReferenceNavigationIntent (_view: EditorView, _intent: ReferenceNavigationIntent): boolean {
  return false
}
