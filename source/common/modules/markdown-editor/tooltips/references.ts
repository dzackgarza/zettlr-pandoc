/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        referenceTooltips
 * CVM-Role:        Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Hover tooltips for workspace reference occurrences
 *                  (issue #1 Phase 4), following the citation-tooltip
 *                  archetype (./citations.ts) with the file-preview DOM
 *                  pattern (./file-preview.ts).
 *
 *                  CONTRACT (locked by test/reference-hover.spec.ts):
 *
 *                  - referenceTooltip() is the hoverTooltip source and is
 *                    exported for direct headless driving. It answers only
 *                    for a position inside a supported-family `@key` token
 *                    whose workspace resolution is RESOLVED; bibliography
 *                    citations stay owned by citationTooltips, plain prose
 *                    and unresolved (missing/duplicate) occurrences return
 *                    null — the tooltip never fabricates a target.
 *                  - The tooltip's pos/end span exactly the authored `@key`
 *                    token (including the `@` sigil).
 *                  - create() produces a DOM containing, each addressable by
 *                    a data attribute:
 *                      [data-reference-type]     the family display name
 *                      [data-reference-key]      the authored key
 *                      [data-reference-path]     the defining documentPath
 *                      [data-reference-section]  the enclosing section text
 *                      [data-reference-excerpt]  a bounded RENDERED excerpt
 *                                                of the definition's
 *                                                previewSource (rendered
 *                                                markdown: no raw fence
 *                                                markers, bounded to the
 *                                                definition's own preview,
 *                                                never the whole document)
 *                      [data-reference-expand]   the expand action indicator
 *                  - The workspace view comes exclusively from
 *                    workspaceReferencesField; while the field is null the
 *                    tooltip answers null.
 *                  - The tooltip never displays any computed reference
 *                    number.
 *
 *                  RED SKELETON: the source always answers null, so the spec
 *                  fails on its tooltip assertions, not on wiring.
 *
 * END HEADER
 */

import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view'

/**
 * The hover source for workspace reference occurrences: the specs drive this
 * function directly against a real EditorView.
 *
 * @param   {EditorView}  _view  The editor view
 * @param   {number}      _pos   The hovered document position
 * @param   {1|-1}        _side  The side of the position being hovered
 *
 * @return  {Tooltip|null}       The tooltip spec, or null
 */
export function referenceTooltip (_view: EditorView, _pos: number, _side: 1 | -1): Tooltip|null {
  // RED skeleton (issue #1 Phase 4): no reference hover is produced yet.
  return null
}

export const referenceTooltips = hoverTooltip(referenceTooltip, { hoverTime: 500 })
