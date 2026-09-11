/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation presentation
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure view derivations of the annotation review
 *                  panel's treatment: relative times, thread message rows,
 *                  the proposal card's counts and the composer's submission.
 *                  The clock is an input; nothing here reads it.
 *
 * END HEADER
 */

import { DateTime } from 'luxon'
import type { AnnotationMessage, AnnotationProposalAction } from '@dts/common/annotation-domain'

/** "2 min. ago", or empty for a timestamp luxon cannot parse. */
export type RelativeTimeLabel = string

/**
 * The label an instant carries against `now`: luxon's short relative form
 * ("2 min. ago", "3 days ago"), `justNow` for anything under a minute
 * either way (luxon would count the seconds), and empty for a timestamp
 * luxon cannot parse.
 */
export function formatRelative (iso: string, now: DateTime, justNow: string): RelativeTimeLabel {
  const time = DateTime.fromISO(iso)
  if (!time.isValid) {
    return ''
  }
  if (Math.abs(now.diff(time).as('minutes')) < 1) {
    return justNow
  }
  const label = time.toRelative({ base: now, style: 'short' })
  return label === null ? '' : label
}

export type AuthorGlyph = 'person' | 'sparkle'

export interface ThreadMessageView {
  messageId: string
  author: AnnotationMessage['author']
  glyph: AuthorGlyph
  authorLabel: string
  relativeTime: RelativeTimeLabel
  text: string
}

export interface ThreadLabels {
  owner: string
  agent: string
  justNow: string
}

export function threadMessageView (message: AnnotationMessage, now: DateTime, labels: ThreadLabels): ThreadMessageView {
  return {
    messageId: message.messageId,
    author: message.author,
    glyph: message.author === 'owner' ? 'person' : 'sparkle',
    authorLabel: message.author === 'owner' ? labels.owner : labels.agent,
    relativeTime: formatRelative(message.createdAt, now, labels.justNow),
    text: message.text
  }
}

export interface ProposalCardView {
  /** Linked proposal actions the owner has not decided yet. */
  pendingCount: number
  totalCount: number
}

export function proposalCardView (actions: readonly AnnotationProposalAction[]): ProposalCardView {
  return {
    pendingCount: actions.filter(action => action.terminalOutcome === undefined).length,
    totalCount: actions.length
  }
}

/** The text a composer draft submits: trimmed, or nothing for an empty draft. */
export function composerSubmission (draft: string): string | undefined {
  const text = draft.trim()
  return text.length === 0 ? undefined : text
}
