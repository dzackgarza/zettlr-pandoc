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

export const SEMANTIC_DIV_CLASSES: Record<string, PandocDivFamily> = {
  // amsthm & Quarto definitions
  definition: 'definition',
  def: 'definition',
  construction: 'definition',
  notation: 'definition',
  assumption: 'definition',
  ass: 'definition',
  axiom: 'definition',
  hyp: 'definition',
  hypothesis: 'definition',

  // amsthm & Quarto results
  theorem: 'result',
  thm: 'result',
  lemma: 'result',
  lem: 'result',
  proposition: 'result',
  prop: 'result',
  prp: 'result',
  corollary: 'result',
  cor: 'result',
  conjecture: 'result',
  conj: 'result',
  cnj: 'result',
  claim: 'result',
  clm: 'result',

  // amsthm & Quarto explanations
  example: 'explanation',
  ex: 'explanation',
  exm: 'explanation',
  remark: 'explanation',
  rem: 'explanation',
  rmk: 'explanation',
  observation: 'explanation',
  obs: 'explanation',
  fact: 'explanation',

  // amsthm & Quarto tasks
  exercise: 'task',
  exr: 'task',
  problem: 'task',
  prob: 'task',
  prb: 'task',
  question: 'task',
  qst: 'task',

  // amsthm & Quarto warnings
  warning: 'warning',
  warn: 'warning',
  wrn: 'warning',
  caution: 'warning',
  cau: 'warning',
  danger: 'warning',
  error: 'warning',

  // amsthm & Quarto proofs
  proof: 'proof',
  prf: 'proof',
  sketch: 'proof',
  solution: 'proof',
  sol: 'proof'
}

const CANONICAL_LABELS: Record<string, string> = {
  def: 'Definition',
  definition: 'Definition',
  thm: 'Theorem',
  theorem: 'Theorem',
  lem: 'Lemma',
  lemma: 'Lemma',
  cor: 'Corollary',
  corollary: 'Corollary',
  prop: 'Proposition',
  prp: 'Proposition',
  proposition: 'Proposition',
  conj: 'Conjecture',
  cnj: 'Conjecture',
  conjecture: 'Conjecture',
  clm: 'Claim',
  claim: 'Claim',
  ass: 'Assumption',
  assumption: 'Assumption',
  axiom: 'Axiom',
  hyp: 'Hypothesis',
  hypothesis: 'Hypothesis',
  ex: 'Example',
  exm: 'Example',
  example: 'Example',
  rem: 'Remark',
  rmk: 'Remark',
  remark: 'Remark',
  obs: 'Observation',
  observation: 'Observation',
  fact: 'Fact',
  exr: 'Exercise',
  exercise: 'Exercise',
  prob: 'Problem',
  prb: 'Problem',
  problem: 'Problem',
  qst: 'Question',
  question: 'Question',
  warn: 'Warning',
  wrn: 'Warning',
  warning: 'Warning',
  cau: 'Caution',
  caution: 'Caution',
  danger: 'Danger',
  error: 'Error',
  proof: 'Proof',
  prf: 'Proof',
  sketch: 'Sketch',
  sol: 'Solution',
  solution: 'Solution'
}

export function humanizeClassName (className: string): string {
  const normalized = className.toLowerCase()
  if (CANONICAL_LABELS[normalized] !== undefined) {
    return CANONICAL_LABELS[normalized]
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
    const match = /^([a-zA-Z0-9]+)(?:[:-].*)$/.exec(id)
    if (match !== null) {
      const prefix = match[1].toLowerCase()
      const family = SEMANTIC_DIV_CLASSES[prefix]
      if (family !== undefined) {
        return { family, label: humanizeClassName(prefix) }
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
