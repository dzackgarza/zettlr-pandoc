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
 * END HEADER
 */

import { hoverTooltip, EditorView, type Tooltip } from '@codemirror/view'
import { md2html } from '@common/modules/markdown-utils/markdown-to-html'
import { sanitizeHTML } from '@common/util/sanitize-html'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { referenceFamilyDisplayName, type ReferenceDefinition } from '@dts/common/references'
import { configField } from '../util/configuration'
import { workspaceReferencesField } from '../plugins/workspace-references-field'

/**
 * The bounded excerpt source of a definition: the previewSource with its
 * fence machinery stripped, so the excerpt never shows raw fence markers or
 * the attribute block. The excerpt stays bounded to the definition's own
 * preview — never the whole defining document.
 *
 * @param   {ReferenceDefinition}  definition  The resolved definition
 *
 * @return  {string}                           The excerpt markdown source
 */
function excerptSource (definition: ReferenceDefinition): string {
  const lines = definition.previewSource.split('\n')

  if (definition.sourceKind === 'theorem-div') {
    // Drop the opening `::: {...}` line and the closing `:::` line.
    const last = lines[lines.length - 1].trim().startsWith(':::') ? -1 : undefined
    return lines.slice(1, last).join('\n').trim()
  }

  if (definition.family === 'lst' && lines.length > 1) {
    // Drop the fence lines of the listing's fenced code block.
    const last = lines[lines.length - 1].trim().startsWith('```') ? -1 : undefined
    return lines.slice(1, last).join('\n').trim()
  }

  // A single authored line bearing the id attribute: strip the trailing
  // attribute block plus caption/heading sigils.
  const line = lines.join('\n')
  const brace = line.lastIndexOf('{')
  const clean = brace === -1 ? line : line.slice(0, brace)
  return clean.replace(/^#+\s*/, '').replace(/^:\s*/, '').trim()
}

/**
 * The hover source for workspace reference occurrences: the specs drive this
 * function directly against a real EditorView.
 *
 * @param   {EditorView}  view  The editor view
 * @param   {number}      pos   The hovered document position
 * @param   {1|-1}        side  The side of the position being hovered
 *
 * @return  {Tooltip|null}      The tooltip spec, or null
 */
export function referenceTooltip (view: EditorView, pos: number, side: 1 | -1): Tooltip|null {
  const references = view.state.field(workspaceReferencesField, false) ?? null
  if (references === null) {
    return null // No workspace view yet: never fabricate a target.
  }

  const occurrence = references.snapshot.occurrences.find(candidate => {
    const { from, to } = candidate.range
    return (pos > from && pos < to) ||
      (pos === from && side === 1) ||
      (pos === to && side === -1)
  })
  if (occurrence === undefined) {
    return null // Plain prose and bibliography citations are not ours.
  }

  const resolution = references.resolutions.get(occurrence.key)
  if (resolution === undefined || resolution.status !== 'resolved') {
    return null // Missing/duplicate occurrences never fabricate a target.
  }

  const { definition } = resolution

  return {
    pos: occurrence.range.from,
    end: occurrence.range.to,
    above: true,
    create (view) {
      return { dom: getPreviewElement(view, occurrence.key, definition) }
    }
  }
}

/**
 * Builds the hover DOM: type, key, defining path, enclosing section, the
 * bounded rendered excerpt, and the expand action indicator.
 *
 * @param   {EditorView}           view        The editor view
 * @param   {string}               key         The authored key
 * @param   {ReferenceDefinition}  definition  The resolved definition
 *
 * @return  {HTMLDivElement}                   The tooltip DOM
 */
function getPreviewElement (view: EditorView, key: string, definition: ReferenceDefinition): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.classList.add('reference-hover-preview')

  const header = document.createElement('p')
  header.classList.add('reference-hover-header')

  const type = document.createElement('span')
  type.dataset.referenceType = 'true'
  type.textContent = referenceFamilyDisplayName(definition.family)
  header.appendChild(type)

  header.appendChild(document.createTextNode(' '))

  const keyElem = document.createElement('span')
  keyElem.dataset.referenceKey = 'true'
  keyElem.textContent = key
  header.appendChild(keyElem)

  const location = document.createElement('p')
  location.classList.add('reference-hover-location')

  const path = document.createElement('span')
  path.dataset.referencePath = 'true'
  path.textContent = definition.documentPath
  location.appendChild(path)

  if (definition.enclosingSection !== undefined) {
    location.appendChild(document.createTextNode(' § '))
    const section = document.createElement('span')
    section.dataset.referenceSection = 'true'
    section.textContent = definition.enclosingSection
    location.appendChild(section)
  }

  const excerpt = document.createElement('div')
  excerpt.classList.add('reference-hover-excerpt')
  excerpt.dataset.referenceExcerpt = 'true'

  // The excerpt is available synchronously as fence-stripped source text and
  // upgrades in place to fully rendered markdown where the citation callback
  // exists (the production renderer window).
  const source = excerptSource(definition)
  excerpt.textContent = source

  if (typeof window.getCitationCallback === 'function') {
    const config = view.state.field(configField, false)
    md2html(source, {
      zknLinkFormat: config?.zknLinkFormat ?? 'link|title',
      onCitation: window.getCitationCallback(CITEPROC_MAIN_DB)
    })
      .then(html => {
        excerpt.innerHTML = sanitizeHTML(html)
      })
      .catch(err => console.error('Could not render the reference excerpt', err))
  }

  const expand = document.createElement('button')
  expand.classList.add('reference-hover-expand')
  expand.dataset.referenceExpand = 'true'
  expand.textContent = 'Expand'
  expand.addEventListener('click', () => {
    excerpt.classList.toggle('expanded')
    expand.textContent = excerpt.classList.contains('expanded') ? 'Collapse' : 'Expand'
  })

  wrapper.appendChild(header)
  wrapper.appendChild(location)
  wrapper.appendChild(excerpt)
  wrapper.appendChild(expand)

  return wrapper
}

export const referenceTooltips = [
  hoverTooltip(referenceTooltip, { hoverTime: 500 }),
  // Provide basic styles for these tooltips
  EditorView.baseTheme({
    '.reference-hover-preview': {
      maxWidth: '360px',
      padding: '8px 10px',
      fontSize: '85%'
    },
    '.reference-hover-preview .reference-hover-header': {
      margin: '0 0 2px 0',
      fontWeight: 'bold'
    },
    '.reference-hover-preview .reference-hover-header [data-reference-key]': {
      fontWeight: 'normal',
      fontFamily: 'monospace',
      marginLeft: '4px'
    },
    '.reference-hover-preview .reference-hover-location': {
      margin: '0 0 6px 0',
      opacity: '0.7',
      fontSize: '90%',
      overflowWrap: 'anywhere'
    },
    '.reference-hover-preview .reference-hover-excerpt': {
      maxHeight: '10em',
      overflow: 'hidden',
      margin: '0 0 6px 0'
    },
    '.reference-hover-preview .reference-hover-excerpt.expanded': {
      maxHeight: 'none',
      overflow: 'auto'
    },
    '.reference-hover-preview .reference-hover-expand': {
      fontSize: '90%'
    }
  })
]
