/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc fenced-div model and semantic classification
 * CVM-Role:        Utility
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     Builds a structural model of a Pandoc fenced div (ranges,
 *                  attributes, semantic family) from a Lezer syntax node.
 *                  Viewport- and view-independent so the same model serves the
 *                  editor renderer and whole-document consumers such as the
 *                  workspace reference index.
 *
 * END HEADER
 */

import type { SyntaxNode } from '@lezer/common'
import { parsePandocAttributes } from './parse-pandoc-attributes'
import { THEOREM_FAMILY_METADATA } from '../util/pandoc-quick-reference'
import {
  referenceFamilyOf,
  referenceFamilyDisplayName,
  QUARTO_FAMILY_ALIASES
} from '../../types/common/references'

export type PandocDivFamily = 'result'|'definition'|'explanation'|'task'|'warning'|'proof'|'generic'

export interface PandocDivModel {
  from: number
  to: number
  openFrom: number
  openTo: number
  contentFrom: number
  contentTo: number
  closeFrom: number
  closeTo: number
  classes: string[]
  id: string
  properties: Record<string, string>
  family: PandocDivFamily
  label: string
  depth: number
}

/**
 * The minimal document surface the model builder needs. CodeMirror's `Text`
 * (i.e. `state.doc`) satisfies this directly; other consumers can adapt a
 * plain string. Kept structural so this module never imports the editor graph.
 */
export interface DivSourceDocument {
  lineAt: (pos: number) => { from: number, to: number }
  sliceString: (from: number, to: number) => string
}

const THEOREM_PREFIX_TO_DIV_FAMILY: Record<string, PandocDivFamily> = {
  thm: 'result',
  lem: 'result',
  prop: 'result',
  cor: 'result',
  conj: 'result',
  clm: 'result',
  def: 'definition',
  ass: 'definition',
  rmk: 'explanation',
  ex: 'explanation',
  obs: 'explanation',
  qst: 'task',
  prob: 'task',
  exr: 'task',
  warn: 'warning',
}

const EXTRA_SEMANTIC_DIV_CLASSES: Record<string, { family: PandocDivFamily, label: string }> = {
  // Proof environments (unnumbered/unreferenceable)
  proof: { family: 'proof', label: 'Proof' },
  prf: { family: 'proof', label: 'Proof' },
  sketch: { family: 'proof', label: 'Sketch' },
  solution: { family: 'proof', label: 'Solution' },
  sol: { family: 'proof', label: 'Solution' },

  // Additional semantic and admonition environments
  caution: { family: 'warning', label: 'Caution' },
  cau: { family: 'warning', label: 'Caution' },
  danger: { family: 'warning', label: 'Danger' },
  error: { family: 'warning', label: 'Error' },
  fact: { family: 'explanation', label: 'Fact' },
  construction: { family: 'definition', label: 'Construction' },
  notation: { family: 'definition', label: 'Notation' },
  axiom: { family: 'definition', label: 'Axiom' },
  hyp: { family: 'definition', label: 'Hypothesis' },
  hypothesis: { family: 'definition', label: 'Hypothesis' },
}

export const SEMANTIC_DIV_CLASSES: Record<string, PandocDivFamily> = {
  // Derive all theorem families from the single authority
  ...Object.fromEntries(
    THEOREM_FAMILY_METADATA.flatMap(metadata => [
      [metadata.divClass.toLowerCase(), THEOREM_PREFIX_TO_DIV_FAMILY[metadata.prefix] ?? 'result'],
      [metadata.prefix.toLowerCase(), THEOREM_PREFIX_TO_DIV_FAMILY[metadata.prefix] ?? 'result']
    ])
  ),
  // Derive all Quarto shorthand aliases
  ...Object.fromEntries(
    QUARTO_FAMILY_ALIASES.map(alias => [
      alias.prefix.toLowerCase(),
      THEOREM_PREFIX_TO_DIV_FAMILY[alias.family] ?? 'result'
    ])
  ),
  // Extra semantic classes (proofs, warnings, definitions)
  ...Object.fromEntries(
    Object.entries(EXTRA_SEMANTIC_DIV_CLASSES).map(([name, item]) => [name, item.family])
  )
}

export function humanizeClassName (className: string): string {
  const lower = className.toLowerCase()
  const extra = EXTRA_SEMANTIC_DIV_CLASSES[lower]
  if (extra !== undefined) {
    return extra.label
  }

  // Check theorem families
  const theoremMatch = THEOREM_FAMILY_METADATA.find(
    m => m.divClass.toLowerCase() === lower || m.prefix.toLowerCase() === lower
  )
  if (theoremMatch !== undefined) {
    return theoremMatch.displayName
  }

  // Check Quarto aliases
  const alias = QUARTO_FAMILY_ALIASES.find(a => a.prefix.toLowerCase() === lower)
  if (alias !== undefined) {
    return referenceFamilyDisplayName(alias.family)
  }

  return className
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

export function classifyDiv (classes: string[], id?: string): { family: PandocDivFamily, label: string } {
  for (const authoredClass of classes) {
    const normalizedClass = authoredClass.toLowerCase()
    const family = SEMANTIC_DIV_CLASSES[normalizedClass]
    if (family !== undefined) {
      return { family, label: humanizeClassName(normalizedClass) }
    }
  }

  if (id !== undefined && id !== '') {
    const refFamily = referenceFamilyOf(id)
    if (refFamily !== undefined) {
      const divFamily = THEOREM_PREFIX_TO_DIV_FAMILY[refFamily]
      if (divFamily !== undefined) {
        return {
          family: divFamily,
          label: referenceFamilyDisplayName(refFamily)
        }
      }
    }
  }

  return {
    family: 'generic',
    label: classes.length > 0 ? `.${classes[0]}` : 'Div',
  }
}

/**
 * Restricts authored properties to those safe to project onto DOM elements.
 */
export function safeProperties (properties: Record<string, string>|undefined): Record<string, string> {
  if (properties === undefined) {
    return {}
  }

  return Object.fromEntries(Object.entries(properties).filter(([name]) => {
    return name === 'role' || name === 'title' || name.startsWith('aria-') || name.startsWith('data-')
  }))
}

export function divModelFromNode (doc: DivSourceDocument, node: SyntaxNode): PandocDivModel|undefined {
  const marks = node.getChildren('PandocDivMark')
  const attrs = node.getChild('PandocAttribute')
  const info = node.getChild('PandocDivInfo')

  if ((!attrs && !info) || marks.length !== 2) {
    return undefined
  }

  const openingLine = doc.lineAt(node.from)
  const closingLine = doc.lineAt(node.to)
  const contentFrom = Math.min(openingLine.to + 1, closingLine.from)
  const attributes = attrs ? parsePandocAttributes(doc.sliceString(attrs.from, attrs.to)) : {}
  const classes = info ? [doc.sliceString(info.from, info.to)] : []
  if (attributes.classes) {
    classes.push(...attributes.classes)
  }

  const classification = classifyDiv(classes, attributes.id)
  let depth = 0
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === 'PandocDiv') {
      depth++
    }
  }
  return {
    from: node.from,
    to: node.to,
    openFrom: openingLine.from,
    openTo: openingLine.to,
    contentFrom,
    contentTo: Math.max(contentFrom, closingLine.from - 1),
    closeFrom: closingLine.from,
    closeTo: closingLine.to,
    classes,
    id: attributes.id ?? '',
    properties: safeProperties(attributes.properties),
    depth,
    ...classification,
  }
}
