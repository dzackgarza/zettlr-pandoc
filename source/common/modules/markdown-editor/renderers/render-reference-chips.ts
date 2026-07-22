/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceChipRenderer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Renders every RESOLVED workspace reference occurrence as
 *                  an independent compact `Type — title` chip (issue #1
 *                  Phase 4).
 *
 *                  CONTRACT (locked by test/editor-reference-chips.spec.ts):
 *
 *                  - The renderer handles a Citation syntax node only when
 *                    EVERY item in the cluster carries a supported reference
 *                    family key (CROSSREF_FAMILIES plus the theorem-div
 *                    prefixes). Pure bibliography clusters stay with
 *                    render-citations byte-identically; mixed
 *                    bibliography/reference clusters are handled by NEITHER
 *                    renderer — they stay raw and receive an advisory
 *                    diagnostic from linters/reference-lint.ts.
 *                  - Each resolved item renders as one independent chip
 *                    (span.reference-chip with data-reference-key and
 *                    data-reference-family) whose text is
 *                    `<Type> — <title>` (the family display name, an
 *                    em-dash, the authored title) or `<Type> — <key>` when
 *                    no title was authored.
 *                  - Authored cluster punctuation, prefixes, suffixes, and
 *                    locators are preserved verbatim around the chips: the
 *                    widget text is the authored cluster text with each
 *                    `@key` token replaced by its chip and the enclosing
 *                    brackets dropped.
 *                  - An occurrence whose key is missing or duplicate renders
 *                    NO chip: the authored source stays raw (diagnostics own
 *                    those states; duplicates never select one definition
 *                    silently).
 *                  - The renderer NEVER displays any number for a reference:
 *                    export tools and templates exclusively own numbering.
 *                  - The workspace view comes exclusively from
 *                    workspaceReferencesField; while the field is null
 *                    nothing renders.
 *
 *                  TAKEOVER DESIGN (green step, documented for reviewers):
 *                  render-citations.ts currently routes all-crossref clusters
 *                  through its own textual `hasCrossref` branch inside
 *                  CitationWidget.toDOM (guarded by isSupportedPandocCrossref
 *                  over fig/tbl/eq/sec) and renders every other cluster —
 *                  including mixed and theorem-family clusters — through the
 *                  citeproc path. The green implementation moves the family
 *                  decision to createWidget time: render-citations declines
 *                  (returns undefined) whenever ANY item is supported-family,
 *                  and this renderer takes exactly the all-supported clusters,
 *                  leaving mixed clusters raw. Bibliography-only clusters
 *                  must keep byte-identical decoration DOM (the parity
 *                  MUST-assert of the spec).
 *
 *                  RED SKELETON: createWidget always declines, so the spec
 *                  fails on its rendering assertions, not on wiring.
 *
 * END HEADER
 */

import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNodeRef } from '@lezer/common'
import { type WidgetType } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import { NODES } from '../parser/citation-parser'

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === NODES.CITATION
}

function createWidget (_state: EditorState, _node: SyntaxNodeRef): WidgetType|undefined {
  // RED skeleton (issue #1 Phase 4): no cluster is rendered yet.
  return undefined
}

export const renderReferenceChips = renderBlockWidgets(shouldHandleNode, createWidget)
