/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Collaboration pure view model
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Everything the workspace annotations panel and the
 *                  editor's inline review and annotation controls derive
 *                  from a DocumentCollaborationSession, with no framework and no
 *                  IPC — one function per derived fact, so each is provable
 *                  on its own. This is where invariant I8 lives: a card's
 *                  title is computed here, every render, from the
 *                  annotation's first message. Nothing stores it.
 *
 * END HEADER
 */

import { Text } from '@codemirror/state'
import type { AnnotationAnchor, TextAnnotation } from '@dts/common/annotation-domain'
import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { ReviewDiffSession } from '@dts/common/review-diff'
import type { SourceRange } from '@dts/common/references'

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
  /** The last line a range target reaches; lineNumber itself for a point
   *  target, absent for an orphaned anchor. */
  endLineNumber: number | undefined
  wordCount: number
  quotedText: string
  instructionText: string
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


function anchorPosition (anchor: AnnotationAnchor): number | undefined {
  if (anchor.state === 'range') {
    return anchor.from
  }
  if (anchor.state === 'point') {
    return anchor.at
  }
  return undefined
}

export interface LineIndex {
  lineOfPosition: (position: number) => number
}

/**
 * Builds a single-pass line offset index for fast O(log N) line lookups.
 * Eliminates repeated multi-megabyte string splits during card derivation.
 */
export function createLineIndex (workingText: string): LineIndex {
  const newlineOffsets: number[] = [0]
  let idx = 0
  while ((idx = workingText.indexOf('\n', idx)) !== -1) {
    newlineOffsets.push(idx + 1)
    idx += 1
  }
  const textLength = workingText.length

  return {
    lineOfPosition (position: number): number {
      const clamped = Math.min(Math.max(position, 0), textLength)
      let low = 0
      let high = newlineOffsets.length - 1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (newlineOffsets[mid] <= clamped) {
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return low
    }
  }
}

/** The 1-based source line a document offset falls on, clamped into the text. */
function lineOfPosition (position: number, workingText: string): number {
  return createLineIndex(workingText).lineOfPosition(position)
}

/** The 1-based source line an anchor's position falls on, or undefined for
 *  an orphaned anchor (no position to report). */
export function lineNumberFor (anchor: AnnotationAnchor, workingText: string): number | undefined {
  const pos = anchorPosition(anchor)
  return pos === undefined ? undefined : lineOfPosition(pos, workingText)
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
  const lineIndex = createLineIndex(workingText)
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
    const pos = anchorPosition(annotation.anchor)
    const lineNumber = pos === undefined ? undefined : lineIndex.lineOfPosition(pos)
    return {
      annotation,
      ordinal: index + 1,
      title: deriveCardTitle(firstMessage.text),
      lineLocator: lineNumber === undefined ? 'Orphaned' : `Ln ${lineNumber}`,
      lineNumber,
      endLineNumber: annotation.anchor.state === 'range' ? lineIndex.lineOfPosition(annotation.anchor.to) : lineNumber,
      wordCount: wordCount(quotedText),
      quotedText,
      instructionText: firstMessage.text,
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

/**
 * Everything on the collaboration panel for which the active document still
 * asks for an owner decision: open annotations plus outstanding review
 * suggestions. This is also the activity-bar badge count.
 */
export function unresolvedCollaborationCount (session: DocumentCollaborationSession): number {
  return openAnnotationCount(session.annotations.items) +
    (session.review === undefined ? 0 : session.review.suggestions.length)
}

export function filterCards (cards: AnnotationCardView[], query: string): AnnotationCardView[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) {
    return cards
  }
  return cards.filter(card =>
    card.title.toLowerCase().includes(needle) ||
    card.quotedText.toLowerCase().includes(needle) ||
    card.instructionText.toLowerCase().includes(needle)
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

export interface SuggestionNavigatorView {
  suggestionId: string
  description: string
  contextText: string
  range: SourceRange
}

/**
 * Workspace-sidebar projection of outstanding review work. This deliberately
 * contains no before/after diff: the editor is the one place review diffs are
 * rendered. Sidebar rows carry the review claim plus current authored source
 * context, then navigate to that exact range.
 */
export function buildSuggestionNavigatorRows (review: ReviewDiffSession): SuggestionNavigatorView[] {
  const doc = Text.of(review.workingText.split('\n'))
  return review.suggestions.map(suggestion => {
    const firstAnchor = suggestion.anchors[0] ?? { from: suggestion.seam, to: suggestion.seam }
    const line = doc.lineAt(Math.min(firstAnchor.from, doc.length))
    return {
      suggestionId: suggestion.suggestionId,
      description: suggestion.description,
      contextText: doc.sliceString(line.from, line.to),
      range: { from: firstAnchor.from, to: firstAnchor.to }
    }
  })
}

/**
 * One outstanding suggestion as the controls under its chunk show it. The
 * editor draws the change itself — a struck-through deletion and a
 * highlighted insertion in the document flow — so the card carries only what
 * the owner decides on: the claim that proposed it and the owner's note.
 */
export interface SuggestionCardView {
  suggestionId: string
  /** The packet's claim: why the agent proposed this change. */
  description: string
  /** The reviewer's own note on this chunk; '' when none was written. */
  comment: string
}

/** A review's outstanding chunks, in the order the provider projected them. */
export function buildSuggestionCards (review: ReviewDiffSession): SuggestionCardView[] {
  return review.suggestions.map(suggestion => ({
    suggestionId: suggestion.suggestionId,
    description: suggestion.description,
    comment: review.chunkComments
      .find(note => note.chunkId === suggestion.suggestionId)?.comment ?? ''
  }))
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
