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
 *                  TAKEOVER DESIGN (green step): render-citations declines a
 *                  cluster at createWidget time whenever the state carries
 *                  workspaceReferencesField AND any item is supported-family
 *                  (states without the field keep the legacy textual
 *                  crossref branch, which test/pandoc-quick-help.spec.ts
 *                  locks). This renderer takes exactly the all-supported,
 *                  all-resolved clusters; partially or fully unresolved
 *                  clusters and mixed clusters stay raw. Bibliography-only
 *                  clusters keep byte-identical decoration DOM (the parity
 *                  MUST-assert of the spec).
 *
 * END HEADER
 */

import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNodeRef } from '@lezer/common'
import { WidgetType, EditorView } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import { NODES, nodeToCiteItem } from '../parser/citation-parser'
import { referenceFamilyOf, referenceFamilyDisplayName, type ReferenceFamily } from '@dts/common/references'
import { workspaceReferencesField } from '../plugins/workspace-references-field'
import clickAndSelect from './click-and-select'

/**
 * One chip of a cluster widget: the authored key, its family, and the
 * display text (`Type — title`, falling back to `Type — key`).
 */
interface ChipSpec {
  key: string
  family: ReferenceFamily
  label: string
}

class ReferenceChipClusterWidget extends WidgetType {
  constructor (readonly rawCluster: string, readonly chips: ChipSpec[]) {
    super()
  }

  eq (other: ReferenceChipClusterWidget): boolean {
    return other.rawCluster === this.rawCluster &&
      JSON.stringify(other.chips) === JSON.stringify(this.chips)
  }

  toDOM (view: EditorView): HTMLElement {
    const elem = document.createElement('span')
    elem.classList.add('reference-chip-cluster')

    // The widget text is the authored cluster text with the enclosing
    // brackets dropped and each `@key` token replaced by its chip; every
    // other authored character (prefixes, separators, locators, suffixes)
    // is preserved verbatim.
    const bracketed = this.rawCluster.startsWith('[') && this.rawCluster.endsWith(']')
    const inner = bracketed ? this.rawCluster.slice(1, -1) : this.rawCluster

    let cursor = 0
    for (const chip of this.chips) {
      const token = '@' + chip.key
      const idx = inner.indexOf(token, cursor)
      if (idx === -1) {
        // Structurally impossible for clusters accepted by createWidget;
        // keep the remaining text authored rather than guessing.
        break
      }

      if (idx > cursor) {
        elem.appendChild(document.createTextNode(inner.slice(cursor, idx)))
      }

      const chipElem = document.createElement('span')
      chipElem.classList.add('reference-chip')
      chipElem.dataset.referenceKey = chip.key
      chipElem.dataset.referenceFamily = chip.family
      chipElem.textContent = chip.label
      elem.appendChild(chipElem)

      cursor = idx + token.length
    }

    if (cursor < inner.length) {
      elem.appendChild(document.createTextNode(inner.slice(cursor)))
    }

    elem.addEventListener('click', clickAndSelect(view))

    return elem
  }

  ignoreEvent (event: Event): boolean {
    return event instanceof MouseEvent
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === NODES.CITATION
}

function createWidget (state: EditorState, node: SyntaxNodeRef): WidgetType|undefined {
  const references = state.field(workspaceReferencesField, false) ?? null
  if (references === null) {
    return undefined // No workspace view yet: nothing renders.
  }

  let citation
  try {
    citation = nodeToCiteItem(node.node, state.sliceDoc())
  } catch (err) {
    return undefined // nodeToCiteItem throws if it is unhappy
  }

  if (citation.items.length === 0) {
    return undefined
  }

  const chips: ChipSpec[] = []
  for (const item of citation.items) {
    const family = referenceFamilyOf(item.id)
    if (family === undefined) {
      // A bibliography key: this is a pure bibliography or mixed cluster,
      // and neither renders through the chips renderer.
      return undefined
    }

    const resolution = references.resolutions.get(item.id)
    if (resolution === undefined || resolution.status !== 'resolved') {
      // Missing or duplicate: the authored source stays raw. Diagnostics
      // own those states; duplicates never select one definition silently.
      return undefined
    }

    const { definition } = resolution
    chips.push({
      key: item.id,
      family,
      label: `${referenceFamilyDisplayName(family)} — ${definition.title ?? item.id}`
    })
  }

  return new ReferenceChipClusterWidget(state.sliceDoc(node.from, node.to), chips)
}

/**
 * Base styling for the chip presentation: compact pills that stay legible in
 * both light and dark themes without ever displaying a computed number.
 */
const chipTheme = EditorView.baseTheme({
  '.reference-chip': {
    display: 'inline-block',
    padding: '0 0.4em',
    margin: '0 0.05em',
    borderRadius: '4px',
    fontSize: '90%',
    whiteSpace: 'nowrap'
  },
  '&light .reference-chip': {
    backgroundColor: 'rgba(28, 120, 176, 0.12)',
    border: '1px solid rgba(28, 120, 176, 0.35)',
    color: '#1c5f8a'
  },
  '&dark .reference-chip': {
    backgroundColor: 'rgba(93, 173, 226, 0.18)',
    border: '1px solid rgba(93, 173, 226, 0.4)',
    color: '#9ecbe8'
  }
})

export const renderReferenceChips = [
  renderBlockWidgets(shouldHandleNode, createWidget),
  chipTheme
]
