/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotations panel pure view model
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Everything the annotations panel derives from a
 *                  DocumentCollaborationSession, with no framework and no
 *                  IPC — one function per derived fact, so each is provable
 *                  on its own. This is where invariant I8 lives: a card's
 *                  title is computed here, every render, from the
 *                  annotation's first message. Nothing stores it.
 *
 * END HEADER
 */

import { Text } from '@codemirror/state'
import type { AnnotationAnchor, TextAnnotation } from '@dts/common/annotation-domain'
import type { ReviewDiffSession } from '@dts/common/review-diff'

export interface AnnotationCardView {
  annotation: TextAnnotation
  /** Document-order position among ALL annotations of this document, open
   *  and resolved alike — the same number the editor gutter marker for this
   *  annotation carries (S4). */
  ordinal: number
  /** Derived from the first message every time (I8): never read from a
   *  stored field. */
  title: string
  lineLocator: string
  /** The same line as lineLocator, as a jump-to-line target — absent for an
   *  orphaned anchor, which has no position to jump to. */
  lineNumber: number | undefined
  wordCount: number
  quotedText: string
  instructionPreview: string
  hasPendingProposal: boolean
}

export interface AnnotationActionRow {
  canReply: boolean
  canShowProposal: boolean
  canReattach: boolean
  resolveLabel: 'Resolve' | 'Reopen'
}

const SENTENCE_END = /[.!?](?:\s|$)/

/** The first sentence of the text, truncated if that sentence itself runs
 *  long. There is no title field on TextAnnotation (I8) — this is computed
 *  fresh from the owner's first message every time a card renders. */
export function deriveCardTitle (firstMessageText: string): string {
  const trimmed = firstMessageText.trim()
  const match = SENTENCE_END.exec(trimmed)
  const sentence = match !== null ? trimmed.slice(0, match.index + 1).trim() : trimmed
  return sentence.length > 72 ? `${sentence.slice(0, 69).trimEnd()}…` : sentence
}

export function truncatePreview (text: string, maxLength = 140): string {
  const trimmed = text.trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1).trimEnd()}…` : trimmed
}

function anchorPosition (anchor: AnnotationAnchor): number | undefined {
  if (anchor.state === 'range') {
    return anchor.from
  }
  if (anchor.state === 'point') {
    return anchor.at
  }
  return undefined
}

/** The 1-based source line a document offset falls on, clamped into the text. */
function lineOfPosition (position: number, workingText: string): number {
  const doc = Text.of(workingText.length === 0 ? [''] : workingText.split('\n'))
  return doc.lineAt(Math.min(Math.max(position, 0), doc.length)).number
}

/** The 1-based source line an anchor's position falls on, or undefined for
 *  an orphaned anchor (no position to report). */
export function lineNumberFor (anchor: AnnotationAnchor, workingText: string): number | undefined {
  const pos = anchorPosition(anchor)
  return pos === undefined ? undefined : lineOfPosition(pos, workingText)
}

/**
 * "Ln N" for a target that still has a position (range or the seam a
 * deletion left behind); an orphaned anchor has no position at all, so it
 * reports that instead of a fabricated line.
 */
export function formatLineLocator (anchor: AnnotationAnchor, workingText: string): string {
  const line = lineNumberFor(anchor, workingText)
  return line === undefined ? 'Orphaned' : `Ln ${line}`
}

function wordCount (text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

/**
 * Every annotation, sorted into document order (position ascending, with
 * orphaned targets — no position — trailing in creation order), and
 * ordinal-numbered in that same order. Open and resolved annotations share
 * one ordinal sequence: the number on a resolved card is the same number its
 * marker carried while it was open.
 */
export function buildAnnotationCards (annotations: TextAnnotation[], workingText: string): AnnotationCardView[] {
  const sorted = [...annotations].sort((a, b) => {
    const posA = anchorPosition(a.anchor) ?? Number.POSITIVE_INFINITY
    const posB = anchorPosition(b.anchor) ?? Number.POSITIVE_INFINITY
    if (posA !== posB) {
      return posA - posB
    }
    return a.createdAt.localeCompare(b.createdAt)
  })
  return sorted.map((annotation, index) => {
    const firstMessage = annotation.messages[0]
    const quotedText = annotation.anchor.quotedText
    return {
      annotation,
      ordinal: index + 1,
      title: deriveCardTitle(firstMessage.text),
      lineLocator: formatLineLocator(annotation.anchor, workingText),
      lineNumber: lineNumberFor(annotation.anchor, workingText),
      wordCount: wordCount(quotedText),
      quotedText,
      instructionPreview: truncatePreview(firstMessage.text),
      hasPendingProposal: annotation.proposalActions.some(action => action.terminalOutcome === undefined)
    }
  })
}

/** S9: resolved cards leave the primary list entirely, behind a disclosure. */
export function partitionByResolution (cards: AnnotationCardView[]): { open: AnnotationCardView[], resolved: AnnotationCardView[] } {
  return {
    open: cards.filter(card => card.annotation.state === 'open'),
    resolved: cards.filter(card => card.annotation.state === 'resolved')
  }
}

/** S10: the header count and the tab badge both count OPEN annotations only. */
export function openAnnotationCount (annotations: TextAnnotation[]): number {
  return annotations.filter(annotation => annotation.state === 'open').length
}

export function filterCards (cards: AnnotationCardView[], query: string): AnnotationCardView[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) {
    return cards
  }
  return cards.filter(card =>
    card.title.toLowerCase().includes(needle) ||
    card.quotedText.toLowerCase().includes(needle) ||
    card.instructionPreview.toLowerCase().includes(needle)
  )
}

/**
 * S8: the detail's action row is terminal — Reply, Show proposal, Reattach,
 * Resolve — and every control it renders is one of these four. Which are
 * enabled, and whether the fourth reads "Resolve" or "Reopen", is state-
 * derived: Show proposal only when a proposal was actually linked, Reattach
 * only while orphaned (S8: recovering an anchor is a visible action, never a
 * background guess), Reply always.
 */
export function deriveActionRow (annotation: TextAnnotation): AnnotationActionRow {
  return {
    canReply: true,
    canShowProposal: annotation.proposalActions.length > 0,
    canReattach: annotation.anchor.state === 'orphaned',
    resolveLabel: annotation.state === 'open' ? 'Resolve' : 'Reopen'
  }
}

/**
 * S7: the chunk ids of a review's outstanding suggestions that came from any
 * of the given packets — how "Show proposal" finds what an annotation's
 * linked AnnotationProposalAction actually points at. Empty when the review
 * has no outstanding chunk from those packets (already decided, or no
 * review at all): the caller has nothing to focus, not an error.
 */
export function suggestionIdsForPacketIds (review: ReviewDiffSession, packetIds: string[]): string[] {
  const wanted = new Set(packetIds)
  return review.suggestions
    .filter(suggestion => suggestion.packetId !== undefined && wanted.has(suggestion.packetId))
    .map(suggestion => suggestion.suggestionId)
}

/**
 * One outstanding suggestion as the SuggestionInspector shows it (M9). The
 * editor renders the same chunk as a locator — a struck-through deletion and
 * a highlighted insertion in the document flow — so this card carries the
 * identity the owner adjudicates on: which claim, which line, and both sides
 * of the change.
 */
export interface SuggestionCardView {
  suggestionId: string
  /** The packet this chunk came from — how a linked annotation's "Show
   *  proposal" finds it (plan S7). Undefined only for a fixture that never
   *  named one. */
  packetId: string | undefined
  /** The packet's claim: why the agent proposed this change. */
  description: string
  lineLocator: string
  /** The line the chunk starts on, as a jump-to-line target. */
  lineNumber: number
  /** What the chunk takes out of the working text; '' for a pure insertion. */
  removedText: string
  /** What it puts in, read out of the working text the anchors index; ''
   *  for a pure deletion, which has no span on the working side. */
  insertedText: string
  /** The reviewer's own note on this chunk; '' when none was written. */
  comment: string
}

/**
 * The panel's view of a review's outstanding chunks, in the order the
 * provider projected them. `insertedText` is sliced out of the SAME
 * workingText the anchors were mapped against — the snapshot's own bytes —
 * so a card can never show a span from a different moment of the document
 * than the offsets that produced it.
 */
export function buildSuggestionCards (review: ReviewDiffSession): SuggestionCardView[] {
  return review.suggestions.map(suggestion => {
    const position = suggestion.anchors[0]?.from ?? suggestion.seam
    return {
      suggestionId: suggestion.suggestionId,
      packetId: suggestion.packetId,
      description: suggestion.description,
      lineLocator: `Ln ${lineOfPosition(position, review.workingText)}`,
      lineNumber: lineOfPosition(position, review.workingText),
      removedText: suggestion.removedText,
      insertedText: suggestion.anchors
        .map(span => review.workingText.slice(span.from, span.to))
        .join(''),
      comment: review.chunkComments
        .find(note => note.chunkId === suggestion.suggestionId)?.comment ?? ''
    }
  })
}

/**
 * What a chunk-note field commits, or `undefined` when it commits nothing.
 *
 * A note that did not change is not a mutation: every commit bumps the
 * review generation, writes the sidecar, and raises an agent event, so
 * sending one for text nobody edited would invalidate the decision the owner
 * is about to make. An EMPTIED field is a change, and the empty string is
 * what removes the note.
 */
export function chunkNoteCommit (card: SuggestionCardView, value: string): string | undefined {
  const text = value.trim()
  return text === card.comment ? undefined : text
}
