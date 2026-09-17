/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ block recognition
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Owns the single editor-side definition of a supported
 *                  TikZ source block. Both the inline renderer and the
 *                  microlocal live-preview surface consume this module so
 *                  they cannot disagree about which source the user is
 *                  editing or which bytes are sent to the render service.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNodeRef } from '@lezer/common'
import { wholeEnvironment } from '@common/util/math-delimiters'

/** Raw LaTeX environments which are rendered as figures. */
export const FIGURE_ENVIRONMENTS: ReadonlySet<string> = new Set([ 'tikzcd', 'tikzpicture' ])

/**
 * The environment a paragraph renders as a raw figure, or null when the
 * paragraph is not exactly one supported TikZ environment.
 */
export function rawTikzEnvironment (paragraphText: string): string|null {
  const environment = wholeEnvironment(paragraphText)
  return environment !== null && FIGURE_ENVIRONMENTS.has(environment) ? environment : null
}

/** Matches a standalone \input{...} referencing a .tikz or .tikzcd file. */
export const INPUT_TIKZ_RE = /^\s*\\input\s*\{\s*([^}]+?\.(?:tikz|tikzcd))\s*\}\s*$/

/**
 * Returns the target file path if the paragraph is a standalone \input command
 * referencing a .tikz or .tikzcd file, or null otherwise.
 */
export function rawTikzInput (paragraphText: string): string|null {
  const match = INPUT_TIKZ_RE.exec(paragraphText)
  return match !== null ? match[1] : null
}

export interface TikzSourceBlock {
  /** The complete Markdown syntax-node range, including fences when present. */
  from: number
  to: number
  /** The range whose bytes are compiled. For a fence this excludes the fences. */
  sourceFrom: number
  sourceTo: number
  source: string
  kind: 'raw'|'fence'
  /** Source language, which also decides how fenced snippets are wrapped for compilation. */
  language: 'tikz'|'tikzcd'
}

/**
 * A fenced source which declares its own LaTeX document intentionally owns
 * its own preamble. The microlocal preview contract is the opposite: snippets
 * must compile through ~/.pandoc/templates/standalone-tikz.tex so the user's
 * packages/macros have one owner. Keep full documents renderable by the legacy
 * inline figure path, but do not present them as template-owned live previews.
 */
export function usesOwnedTikzTemplate (block: TikzSourceBlock): boolean {
  if (block.kind === 'raw') {
    return true
  }
  const declaresDocumentClass = /\\documentclass(?:\[[^\]]*\])?\s*\{/.test(block.source)
  const hasDocumentBody = /\\begin\s*\{document\}/.test(block.source)
  return !(declaresDocumentClass && hasDocumentBody)
}

/**
 * Converts one Markdown syntax node into the TikZ source it represents.
 * Undefined means that node is not one of the supported figure forms.
 */
export function tikzBlockForNode (state: EditorState, node: SyntaxNodeRef): TikzSourceBlock|undefined {
  if (node.type.name === 'Paragraph') {
    const source = state.sliceDoc(node.from, node.to)
    const environment = rawTikzEnvironment(source)
    if (environment !== null) {
      return {
        from: node.from,
        to: node.to,
        sourceFrom: node.from,
        sourceTo: node.to,
        source,
        kind: 'raw',
        language: environment === 'tikzcd' ? 'tikzcd' : 'tikz'
      }
    }

    const inputPath = rawTikzInput(source)
    if (inputPath !== null) {
      return {
        from: node.from,
        to: node.to,
        sourceFrom: node.from,
        sourceTo: node.to,
        source,
        kind: 'raw',
        language: inputPath.endsWith('.tikzcd') ? 'tikzcd' : 'tikz'
      }
    }

    return undefined
  }

  if (node.type.name !== 'FencedCode') {
    return undefined
  }

  const info = node.node.getChild('CodeInfo')
  if (info === null) {
    return undefined
  }
  const infoText = state.sliceDoc(info.from, info.to).trim()
  const isTikz = infoText === 'tikz' || /^\{[^}]*\.tikz[\s}]/.test(infoText)
  const isTikzCd = infoText === 'tikzcd' || /^\{[^}]*\.tikzcd[\s}]/.test(infoText)
  if (!isTikz && !isTikzCd) {
    return undefined
  }

  const body = node.node.getChild('CodeText')
  if (body === null) {
    return undefined
  }
  return {
    from: node.from,
    to: node.to,
    sourceFrom: body.from,
    sourceTo: body.to,
    source: state.sliceDoc(body.from, body.to),
    kind: 'fence',
    language: isTikzCd ? 'tikzcd' : 'tikz'
  }
}

/**
 * Returns the supported TikZ block containing the main caret, if any.
 *
 * The syntax node under the caret may be a link/attribute/etc. nested inside
 * the paragraph, or CodeText inside a fenced block, so walk upward until the
 * renderer-level block node is reached rather than inspecting only the leaf.
 */
export function activeTikzBlock (state: EditorState): TikzSourceBlock|null {
  const selection = state.selection.main
  // Rendered widgets use the editor's normal edit-first activation semantics:
  // clicking one selects the full source range. In that state the selection
  // head is exactly at the block's closing boundary, where resolveInner(...,
  // +1) belongs to whatever follows the block. Resolve from the selection's
  // inside/start edge for a non-empty selection so the sidecar and CodeMirror
  // agree that the just-activated rendered object is being edited.
  const probe = selection.empty ? selection.head : selection.from
  const assoc = probe === state.doc.length ? -1 : 1
  let node = syntaxTree(state).resolveInner(probe, assoc)

  while (node.parent !== null && node.type.name !== 'Paragraph' && node.type.name !== 'FencedCode') {
    node = node.parent
  }

  const block = tikzBlockForNode(state, node)
  if (
    block === undefined ||
    selection.to < block.from ||
    selection.from > block.to ||
    !usesOwnedTikzTemplate(block)
  ) {
    return null
  }
  return block
}

/**
 * Returns the TikZ/TikZCD block containing an arbitrary document position.
 * Unlike `activeTikzBlock`, this is selection-independent and is therefore
 * suitable for completion/language services.
 */
export function tikzBlockAt (state: EditorState, pos: number): TikzSourceBlock|null {
  const bounded = Math.max(0, Math.min(pos, state.doc.length))
  for (const [probe, assoc] of [
    [bounded, -1],
    [bounded, 1],
  ] as const) {
    let node = syntaxTree(state).resolveInner(probe, assoc)
    while (node.parent !== null && node.type.name !== 'Paragraph' && node.type.name !== 'FencedCode') {
      node = node.parent
    }
    const block = tikzBlockForNode(state, node)
    if (block !== undefined && bounded >= block.sourceFrom && bounded <= block.sourceTo) {
      return block
    }
  }
  return null
}
