/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Create-reference-label request signal
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The contextual "Create reference label…" signal (issue #1
 *                  Phase 6, workstream 3). The context menu (or the command
 *                  registry entry) resolves the supported, still-unlabeled
 *                  reference target at a position — a theorem-like fenced
 *                  div, a heading, a figure image, a fenced code listing, or
 *                  a display-math block — into a typed request carrying the
 *                  context-FIXED family, an editable slug proposal, and the
 *                  exact insertion the host must perform once the
 *                  CreateReferenceLabelDialog confirms a key. The dispatched
 *                  StateEffect is re-emitted by the MarkdownEditor update
 *                  listener as a 'create-reference-label' event, which
 *                  MainEditor.vue relays up to App.vue's dialog mount
 *                  (mirroring the Mod-P reference search signal).
 *
 * END HEADER
 */

import { StateEffect } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { type Command, type EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { THEOREM_DIV_PREFIXES } from '@common/util/pandoc-quick-reference'
import { extractReferences } from '@common/pandoc-util/extract-references'
import type { ReferenceFamily } from '@dts/common/references'
import { nodeAtPos } from '../util/node-in-selection'

/**
 * The single intent the CreateReferenceLabelDialog emits on confirmation:
 * the full key, the explicit label token the host inserts at the prepared
 * position ('#' + key), and the @-reference the host copies to the
 * clipboard ('@' + key).
 */
export interface CreateReferenceLabelIntent {
  key: string
  insertText: string
  clipboardText: string
}

/**
 * The exact label insertion prepared at request time: replace [from, to)
 * with `prefix + insertText + suffix`, where insertText is the dialog
 * intent's explicit label token ('#' + key).
 */
export interface ReferenceLabelInsertion {
  from: number
  to: number
  prefix: string
  suffix: string
}

/**
 * A typed create-label request: the family is FIXED by the invoking context
 * and the insertion is prepared against the request-time document.
 */
export interface CreateReferenceLabelRequest {
  family: ReferenceFamily
  proposedSlug: string
  insertion: ReferenceLabelInsertion
  /**
   * The exact authored text of the target's open line at preparation time
   * (issue #1 Phase 8): the CONTENT anchor confirm-time re-resolution uses
   * to re-locate the target after intervening edits. The dialog is modal
   * only visually — the document can shift underneath it (a workspace
   * rename lands, another pane edits the buffer), so the prepared offsets
   * alone are not trustworthy at confirm time.
   */
  targetLine: string
}

/**
 * The typed outcome of confirm-time re-resolution
 * (confirmReferenceLabelInsertion below).
 */
export type ConfirmReferenceLabelOutcome =
  | { status: 'applied', insertion: ReferenceLabelInsertion }
  | { status: 'stale', reason: 'target-vanished' | 'already-labeled' }

/**
 * Signals that the user requested the create-reference-label dialog for a
 * resolved target context.
 */
export const openCreateReferenceLabelEffect = StateEffect.define<CreateReferenceLabelRequest>()

/** The node names that can anchor a label creation. */
const TARGET_NODES = [
  'PandocDiv',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
  'Image',
  'FencedCode'
]

/** Maps a referenceable fenced-div class back to its label family. */
const CLASS_TO_FAMILY = new Map<string, ReferenceFamily>(
  Object.entries(THEOREM_DIV_PREFIXES).map(([ family, divClass ]) => [ divClass, family as ReferenceFamily ])
)

/**
 * Reduces a title-ish string to an editable slug proposal: lowercase
 * kebab-case restricted to the characters an authored key token survives.
 *
 * @param   {string}  text  The source text
 *
 * @return  {string}        The proposed slug (possibly empty)
 */
function proposeSlug (text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
}

/**
 * Returns the complete line of the document containing pos.
 */
function lineAt (view: EditorView, pos: number): { from: number, to: number, text: string } {
  const line = view.state.doc.lineAt(pos)
  return { from: line.from, to: line.to, text: line.text }
}

/**
 * Resolves the supported, still-unlabeled reference target at a position
 * into a create-label request, or null when the position offers none.
 *
 * @param   {EditorView}  view  The editor view
 * @param   {number}      pos   The invoking position
 *
 * @return  {CreateReferenceLabelRequest|null}  The typed request, if any
 */
export function resolveCreateReferenceLabelRequest (view: EditorView, pos: number): CreateReferenceLabelRequest|null {
  const node = nodeAtPos(pos, syntaxTree(view.state), TARGET_NODES)
  if (node === null) {
    return null
  }

  const request = resolveNodeRequest(view, node)
  if (request === null) {
    return null
  }

  // Never offer a second label: if the real extractor already finds a
  // definition on the target's own lines, the context is labeled.
  const openLine = lineAt(view, node.from)
  const closeLine = lineAt(view, node.to)
  const definitions = extractReferences('', view.state.doc.toString()).definitions
  const alreadyLabeled = definitions.some(d => d.range.from >= openLine.from && d.range.to <= closeLine.to)
  if (alreadyLabeled) {
    return null
  }

  return request
}

/**
 * Builds the family, slug proposal, and prepared insertion for one target
 * node, or null when the node is not a labelable context (e.g. a proof-like
 * div or a non-theorem div class).
 */
function resolveNodeRequest (view: EditorView, node: SyntaxNode): CreateReferenceLabelRequest|null {
  const openLine = lineAt(view, node.from)

  if (node.name === 'PandocDiv') {
    // The class registry decides the family; proof-like and unknown div
    // classes are never labelable.
    const classMatch = openLine.text.match(/^:{3,}\s*(?:\{\s*)?\.?([a-zA-Z-]+)/)
    const family = classMatch !== null ? CLASS_TO_FAMILY.get(classMatch[1].toLowerCase()) : undefined
    if (family === undefined) {
      return null
    }

    const title = openLine.text.match(/title="([^"]*)"/)?.[1] ?? ''
    const brace = openLine.text.indexOf('{')
    if (brace !== -1) {
      // Attribute form: insert the id inside the existing block, before '}'.
      const close = openLine.text.indexOf('}', brace)
      if (close === -1) {
        return null
      }
      return {
        family,
        proposedSlug: proposeSlug(title),
        insertion: { from: openLine.from + close, to: openLine.from + close, prefix: ' ', suffix: '' },
        targetLine: openLine.text
      }
    }

    // Bare form `::: theorem`: rewrite the class word into an attribute
    // block carrying both the class and the new id.
    const className = classMatch?.[1] ?? ''
    const classStart = openLine.from + openLine.text.indexOf(className)
    return {
      family,
      proposedSlug: proposeSlug(title),
      insertion: { from: classStart, to: classStart + className.length, prefix: `{.${className} `, suffix: '}' },
      targetLine: openLine.text
    }
  }

  if (node.name.startsWith('ATXHeading') || node.name.startsWith('SetextHeading')) {
    const headingText = openLine.text.replace(/^#+\s*/, '').replace(/\{[^}]*\}\s*$/, '').trim()
    const brace = openLine.text.lastIndexOf('{')
    if (brace !== -1 && openLine.text.trimEnd().endsWith('}')) {
      const close = openLine.text.lastIndexOf('}')
      return {
        family: 'sec',
        proposedSlug: proposeSlug(headingText),
        insertion: { from: openLine.from + close, to: openLine.from + close, prefix: ' ', suffix: '' },
        targetLine: openLine.text
      }
    }
    return {
      family: 'sec',
      proposedSlug: proposeSlug(headingText),
      insertion: { from: openLine.to, to: openLine.to, prefix: ' {', suffix: '}' },
      targetLine: openLine.text
    }
  }

  if (node.name === 'Image') {
    // pandoc-crossref figure attributes attach directly after the closing
    // parenthesis, without a space.
    const alt = view.state.sliceDoc(node.from, node.to).match(/^!\[([^\]]*)\]/)?.[1] ?? ''
    return {
      family: 'fig',
      proposedSlug: proposeSlug(alt),
      insertion: { from: node.to, to: node.to, prefix: '{', suffix: '}' },
      targetLine: openLine.text
    }
  }

  if (node.name === 'FencedCode') {
    const opening = openLine.text.trimStart()

    if (opening.startsWith('$$')) {
      // Display math: the equation attribute trails the closing delimiter.
      const closeLine = lineAt(view, node.to)
      return {
        family: 'eq',
        proposedSlug: '',
        insertion: { from: closeLine.to, to: closeLine.to, prefix: ' {', suffix: '}' },
        targetLine: openLine.text
      }
    }

    // Code listing: extend or create the info attribute block.
    const brace = openLine.text.indexOf('{')
    if (brace !== -1) {
      const close = openLine.text.indexOf('}', brace)
      if (close === -1) {
        return null
      }
      return {
        family: 'lst',
        proposedSlug: '',
        insertion: { from: openLine.from + close, to: openLine.from + close, prefix: ' ', suffix: '' },
        targetLine: openLine.text
      }
    }

    const infoMatch = openLine.text.match(/^([`~]{3,})\s*(\S*)\s*$/)
    if (infoMatch === null) {
      return null
    }
    const infoStart = openLine.from + infoMatch[1].length
    return {
      family: 'lst',
      proposedSlug: proposeSlug(infoMatch[2]),
      insertion: {
        from: infoStart,
        to: openLine.to,
        prefix: infoMatch[2] === '' ? '{' : `{.${infoMatch[2]} `,
        suffix: '}'
      },
      targetLine: openLine.text
    }
  }

  return null
}

/**
 * Re-resolves a prepared create-label request against the CURRENT document
 * at confirm time (issue #1 Phase 8).
 *
 * CONTRACT (locked red by test/reference-create-label-confirm.spec.ts):
 *
 * The dialog is modal only visually: between preparation and confirmation
 * the document can shift (a workspace rename lands, a second pane edits the
 * buffer, content is pasted above the target). The prepared
 * request.insertion offsets are therefore untrustworthy at confirm time and
 * MUST NOT be applied verbatim. Confirming re-locates the target through
 * its content anchor (request.targetLine):
 *
 * - The target's open line still exists in the current document (preferring
 *   the line still containing the original offsets, otherwise the unique
 *   line equal to targetLine) and re-resolving there yields a same-family
 *   still-unlabeled request: the outcome is
 *   { status: 'applied', insertion } where insertion is the FRESHLY
 *   RECOMPUTED insertion for the target's current position — byte-identical
 *   to what resolveCreateReferenceLabelRequest would prepare there now.
 *
 * - The target's own lines already carry a definition (someone labeled it
 *   while the dialog was open — the real extractor is the authority, the
 *   same alreadyLabeled gate preparation uses): the outcome is
 *   { status: 'stale', reason: 'already-labeled' } and NOTHING may be
 *   inserted; the host surfaces the structured staleness instead.
 *
 * - The target no longer exists (its open line was deleted or rewritten,
 *   or no unique same-family target matches the anchor): the outcome is
 *   { status: 'stale', reason: 'target-vanished' } and NOTHING may be
 *   inserted.
 *
 * PHASE 8 INERT SKELETON: this reproduces the current confirm behavior —
 * the host applies the request-time offsets verbatim — by returning the
 * original insertion unconditionally. Every recompute and staleness branch
 * above is locked red by test/reference-create-label-confirm.spec.ts.
 *
 * @param   {EditorView}                   _view    The editor view (current document)
 * @param   {CreateReferenceLabelRequest}  request  The request prepared at dialog-open time
 *
 * @return  {ConfirmReferenceLabelOutcome}          The recomputed insertion or a typed stale result
 */
export function confirmReferenceLabelInsertion (
  _view: EditorView,
  request: CreateReferenceLabelRequest
): ConfirmReferenceLabelOutcome {
  return { status: 'applied', insertion: request.insertion }
}

/**
 * Resolves the target at pos and dispatches the create-label request.
 *
 * @param   {EditorView}  view  The editor view
 * @param   {number}      pos   The invoking position
 *
 * @return  {boolean}           Whether a request was dispatched
 */
export function requestCreateReferenceLabel (view: EditorView, pos: number): boolean {
  const request = resolveCreateReferenceLabelRequest(view, pos)
  if (request === null) {
    return false
  }

  view.dispatch({ effects: openCreateReferenceLabelEffect.of(request) })
  return true
}

/**
 * The command-registry entry: requests a label for the target context at the
 * primary selection.
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {boolean}           Whether a labelable target was found
 */
export const createReferenceLabel: Command = view => {
  return requestCreateReferenceLabel(view, view.state.selection.main.head)
}
