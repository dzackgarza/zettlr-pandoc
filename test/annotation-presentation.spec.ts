/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation presentation tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure derivations the annotation review panel renders
 *                  from (annotation-presentation.ts), each against an
 *                  injected clock: the relative time a message carries, the
 *                  author row a thread message becomes, the proposal card's
 *                  counts, the composer's submission, and the line span the
 *                  selected-text card names.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { DateTime } from 'luxon'
import {
  composerSubmission,
  formatRelative,
  proposalCardView,
  threadMessageView
} from 'source/win-main/sidebar/annotations/annotation-presentation'
import { buildAnnotationCards } from 'source/win-main/sidebar/annotations/annotation-panel-model'
import type { AnnotationMessage, AnnotationProposalAction, TextAnnotation } from '@dts/common/annotation-domain'

const NOW = DateTime.fromISO('2026-05-20T10:02:00.000Z')
const LABELS = { owner: 'You', agent: 'AI', justNow: 'Just now' }

describe('annotation-presentation', function () {
  it('labels an instant against the injected clock, in luxon\'s short relative form', function () {
    assert.equal(formatRelative('2026-05-20T10:00:00.000Z', NOW, LABELS.justNow), '2 min. ago')
    assert.equal(formatRelative('2026-05-20T08:02:00.000Z', NOW, LABELS.justNow), '2 hr. ago')
    assert.equal(formatRelative('2026-05-17T10:02:00.000Z', NOW, LABELS.justNow), '3 days ago')
  })

  it('reads anything under a minute old as just now, never as a count of seconds', function () {
    assert.equal(formatRelative('2026-05-20T10:01:40.000Z', NOW, LABELS.justNow), 'Just now')
    assert.equal(formatRelative('2026-05-20T10:02:00.000Z', NOW, LABELS.justNow), 'Just now')
  })

  it('renders an unparsable timestamp as an empty label', function () {
    assert.equal(formatRelative('not a timestamp', NOW, LABELS.justNow), '')
  })

  it('maps the owner to the person glyph and the agent to the sparkle glyph, each with its label and time', function () {
    const owner: AnnotationMessage = { messageId: 'm-1', author: 'owner', text: 'Add a source here.', createdAt: '2026-05-20T10:00:00.000Z' }
    const agent: AnnotationMessage = { messageId: 'm-2', author: 'agent', clientRequestId: 'req-1', text: 'Two candidates follow.', createdAt: '2026-05-20T10:01:30.000Z' }
    assert.deepEqual(threadMessageView(owner, NOW, LABELS), {
      messageId: 'm-1', author: 'owner', glyph: 'person', authorLabel: 'You', relativeTime: '2 min. ago', text: 'Add a source here.'
    })
    assert.deepEqual(threadMessageView(agent, NOW, LABELS), {
      messageId: 'm-2', author: 'agent', glyph: 'sparkle', authorLabel: 'AI', relativeTime: 'Just now', text: 'Two candidates follow.'
    })
  })

  it('counts a proposal card by the linked actions still undecided', function () {
    const actions: AnnotationProposalAction[] = [
      { actionId: 'a-1', packetId: 'p-1', reviewId: 'r-1', linkedAt: '2026-05-20T10:00:00.000Z', terminalOutcome: 'accepted' },
      { actionId: 'a-2', packetId: 'p-2', reviewId: 'r-1', linkedAt: '2026-05-20T10:00:30.000Z' },
      { actionId: 'a-3', packetId: 'p-3', reviewId: 'r-1', linkedAt: '2026-05-20T10:01:00.000Z' }
    ]
    assert.deepEqual(proposalCardView(actions), { pendingCount: 2, totalCount: 3 })
  })

  it('submits a trimmed draft, and nothing for whitespace', function () {
    assert.equal(composerSubmission('  Please cite the erratum.  '), 'Please cite the erratum.')
    assert.equal(composerSubmission(' \n '), undefined)
  })

  it('reports the last line a range target reaches, for the selected-text card', function () {
    const workingText = 'First line.\nSecond line runs on.\nThird line ends here.'
    const message: AnnotationMessage = { messageId: 'm', author: 'owner', text: 'Tighten this.', createdAt: '2026-05-20T10:00:00.000Z' }
    const spanning: TextAnnotation = {
      annotationId: 'span',
      documentId: 'doc',
      anchor: { state: 'range', from: 12, to: 40, quotedText: workingText.slice(12, 40) },
      state: 'open',
      messages: [message],
      proposalActions: [],
      createdAt: '2026-05-20T10:00:00.000Z',
      updatedAt: '2026-05-20T10:00:00.000Z'
    }
    const point: TextAnnotation = {
      ...spanning,
      annotationId: 'point',
      anchor: { state: 'point', at: 33, quotedText: 'runs on', reason: 'target-deleted' }
    }
    const [spanCard, pointCard] = buildAnnotationCards([spanning, point], workingText)
    assert.equal(spanCard.lineNumber, 2)
    assert.equal(spanCard.endLineNumber, 3)
    assert.equal(pointCard.lineNumber, 3)
    assert.equal(pointCard.endLineNumber, 3)
  })
})
