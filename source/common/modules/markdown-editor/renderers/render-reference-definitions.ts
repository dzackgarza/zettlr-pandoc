/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceDefinitionBadgeRenderer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Decorates every reference definition in the current
 *                  document with a subtle label badge and an always-visible
 *                  citing-count badge (issue #1 Phase 4).
 *
 *                  CONTRACT (locked by test/editor-reference-badges.spec.ts):
 *
 *                  - The definition set is exactly
 *                    workspaceReferencesField.snapshot.definitions (the
 *                    current document's live snapshot); while the field is
 *                    null nothing renders and no counts are fabricated.
 *                  - Every definition receives one subtle label badge
 *                    (span.reference-definition-badge with
 *                    data-reference-key) whose text is the authored key, and
 *                    one separate always-visible count badge
 *                    (span.reference-count-badge with data-reference-key and
 *                    data-citing-count), INCLUDING when the count is zero.
 *                  - The citing count of a definition is the number of
 *                    entries in workspaceOccurrences whose key equals the
 *                    definition's key — occurrences across the whole merged
 *                    workspace view, not just this document. The badge text
 *                    is `1 reference` for exactly one citing location and
 *                    `N references` otherwise (including `0 references`).
 *                  - Badges present themselves beside the authored source:
 *                    they never replace, hide, or renumber authored text,
 *                    and they never display any computed reference number.
 *                  - Clicking a count badge emits the same signal family as
 *                    Mod-P: it dispatches
 *                    openReferenceSearchEffect.of({ key }) so the shared
 *                    overlay opens populated with that definition's workspace
 *                    citing locations. The assertion target is that emitted
 *                    intent (and the badge's own count), never overlay
 *                    internals.
 *
 *                  IMPLEMENTATION NOTE: the badge DOM is owned by a
 *                  ViewPlugin that synchronizes one badge group per
 *                  definition into its own overlay container (the panel and
 *                  gutter archetype). Inline widget decorations cannot
 *                  satisfy the contract because CodeMirror only materializes
 *                  viewport lines, while the count badges of EVERY
 *                  definition must be present and clickable. Geometry is
 *                  applied in the measure cycle; badge groups whose
 *                  definition line has no layout yet stay unpositioned.
 *
 * END HEADER
 */

import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import { type SourceRange } from '@dts/common/references'
import { workspaceReferencesField, workspaceReferencesUpdate } from '../plugins/workspace-references-field'
import { openReferenceSearchEffect } from '../plugins/reference-search-effect'

/**
 * One synchronized badge group: the definition it decorates (with its live
 * range) and the group's DOM (label badge plus count badge).
 */
interface BadgeGroup {
  key: string
  citingCount: number
  range: SourceRange
  dom: HTMLElement
}

/**
 * Builds the DOM of one badge group: the subtle label badge showing the
 * authored key and the always-visible, clickable citing-count badge.
 */
function buildBadgeGroup (
  view: EditorView,
  key: string,
  citingCount: number
): HTMLElement {
  const group = document.createElement('span')
  group.classList.add('reference-badge-group')

  const label = document.createElement('span')
  label.classList.add('reference-definition-badge')
  label.dataset.referenceKey = key
  label.textContent = key
  group.appendChild(label)

  const count = document.createElement('span')
  count.classList.add('reference-count-badge')
  count.dataset.referenceKey = key
  count.dataset.citingCount = String(citingCount)
  count.textContent = citingCount === 1 ? '1 reference' : `${citingCount} references`
  count.addEventListener('click', () => {
    // The same signal family as Mod-P, keyed to this definition: App.vue
    // opens the shared overlay over the provider's freshly fetched merged
    // snapshot — the single owner of the citing-locations fact (issue #46).
    view.dispatch({
      effects: openReferenceSearchEffect.of({ key })
    })
  })
  group.appendChild(count)

  return group
}

class ReferenceDefinitionBadges {
  private readonly container: HTMLElement
  private groups: BadgeGroup[]
  private readonly measureReq: { read: () => Array<{ left: number, top: number }|null>, write: (positions: Array<{ left: number, top: number }|null>) => void }

  constructor (private readonly view: EditorView) {
    this.container = document.createElement('div')
    this.container.classList.add('reference-definition-badge-layer')
    this.container.setAttribute('aria-hidden', 'true')
    view.scrollDOM.appendChild(this.container)
    this.groups = []
    this.measureReq = {
      read: () => this.measurePositions(),
      write: positions => this.applyPositions(positions)
    }
    this.sync(view.state)
    view.requestMeasure(this.measureReq)
  }

  update (update: ViewUpdate): void {
    const hasPayload = update.transactions.some(transaction => {
      return transaction.effects.some(effect => effect.is(workspaceReferencesUpdate))
    })

    if (hasPayload) {
      this.sync(update.state)
      update.view.requestMeasure(this.measureReq)
      return
    }

    if (update.docChanged) {
      // The snapshot ranges are stale relative to the new buffer until the
      // next payload arrives: keep the badges anchored by mapping.
      for (const group of this.groups) {
        group.range = {
          from: update.changes.mapPos(group.range.from),
          to: update.changes.mapPos(group.range.to)
        }
      }
    }

    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      update.view.requestMeasure(this.measureReq)
    }
  }

  destroy (): void {
    this.container.remove()
  }

  /**
   * Rebuilds the badge DOM from the current workspace view: one badge group
   * per definition, in document order. While the field is null nothing
   * renders and no counts are fabricated.
   */
  private sync (state: EditorState): void {
    const references = state.field(workspaceReferencesField, false) ?? null
    this.container.replaceChildren()
    this.groups = []

    if (references === null) {
      return
    }

    const citingCounts = new Map<string, number>()
    for (const occurrence of references.workspaceOccurrences) {
      citingCounts.set(occurrence.key, (citingCounts.get(occurrence.key) ?? 0) + 1)
    }

    for (const definition of references.snapshot.definitions) {
      const citingCount = citingCounts.get(definition.key) ?? 0
      const dom = buildBadgeGroup(this.view, definition.key, citingCount)
      this.container.appendChild(dom)
      this.groups.push({ key: definition.key, citingCount, range: { ...definition.range }, dom })
    }
  }

  /**
   * Measure phase: the badge group of a definition hangs at the end of the
   * line bearing the authored id token. Lines without layout (outside the
   * viewport) yield null.
   */
  private measurePositions (): Array<{ left: number, top: number }|null> {
    const base = this.container.getBoundingClientRect()
    return this.groups.map(group => {
      if (group.range.to > this.view.state.doc.length) {
        return null
      }

      const lineEnd = this.view.state.doc.lineAt(group.range.to).to
      const coords = this.view.coordsAtPos(lineEnd, -1)
      if (coords === null) {
        return null
      }

      return { left: coords.right - base.left + 8, top: coords.top - base.top }
    })
  }

  /**
   * Write phase: positions every badge group, hiding groups whose line has
   * no layout.
   */
  private applyPositions (positions: Array<{ left: number, top: number }|null>): void {
    this.groups.forEach((group, index) => {
      const position = positions[index] ?? null
      if (position === null) {
        group.dom.classList.remove('positioned')
        return
      }

      group.dom.classList.add('positioned')
      group.dom.style.left = `${position.left}px`
      group.dom.style.top = `${position.top}px`
    })
  }
}

const badgePlugin = ViewPlugin.fromClass(ReferenceDefinitionBadges)

/**
 * Base styling for the badges: the label badge is subtle, the count badge is
 * always visible and clickable, and neither ever displays a computed number
 * for the reference itself.
 */
const badgeTheme = EditorView.baseTheme({
  '.reference-definition-badge-layer': {
    position: 'absolute',
    inset: '0',
    zIndex: '2',
    pointerEvents: 'none'
  },
  '.reference-badge-group': {
    position: 'absolute',
    display: 'none',
    whiteSpace: 'nowrap'
  },
  '.reference-badge-group.positioned': {
    display: 'inline-flex',
    gap: '0.35em'
  },
  '.reference-definition-badge, .reference-count-badge': {
    display: 'inline-block',
    padding: '0 0.35em',
    borderRadius: '3px',
    fontSize: '75%'
  },
  '.reference-count-badge': {
    cursor: 'pointer',
    pointerEvents: 'auto'
  },
  '&light .reference-definition-badge': {
    backgroundColor: 'rgba(120, 120, 120, 0.08)',
    border: '1px solid rgba(120, 120, 120, 0.22)',
    color: '#777777'
  },
  '&dark .reference-definition-badge': {
    backgroundColor: 'rgba(200, 200, 200, 0.1)',
    border: '1px solid rgba(200, 200, 200, 0.22)',
    color: '#999999'
  },
  '&light .reference-count-badge': {
    backgroundColor: 'rgba(28, 120, 176, 0.1)',
    border: '1px solid rgba(28, 120, 176, 0.3)',
    color: '#1c5f8a'
  },
  '&dark .reference-count-badge': {
    backgroundColor: 'rgba(93, 173, 226, 0.15)',
    border: '1px solid rgba(93, 173, 226, 0.35)',
    color: '#9ecbe8'
  }
})

export const renderReferenceDefinitions = [ badgePlugin, badgeTheme ]
