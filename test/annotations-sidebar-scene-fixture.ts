/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotations panel scene fixture
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One DocumentCollaborationSession shared by the panel's
 *                  unit spec and its visual capture entry: three
 *                  annotations covering the three states the structural
 *                  gate cares about — an open thread with no proposal, an
 *                  open thread with a pending linked proposal, and a
 *                  resolved thread.
 *
 *                  The same fixture also carries the OTHER half of a
 *                  collaboration session on demand: buildSceneSessionWithReview
 *                  adds two outstanding suggestions over the same working
 *                  text, which is what the SuggestionInspector (M9) reads.
 *
 * END HEADER
 */

import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { TextAnnotation } from '@dts/common/annotation-domain'
import type { ReviewDiffSession } from '@dts/common/review-diff'

export const SCENE_DOCUMENT_ID = 'doc-annotations-scene'
export const SCENE_DOCUMENT_PATH = '/tmp/annotations-scene-note.md'

export const SCENE_WORKING_TEXT = [
  '# The Future of AI and Human Creativity',
  '',
  'Susskind argues that as AI systems take over more routine cognitive tasks, the premium will be on human abilities that are difficult to automate: framing problems, judgment, empathy, and meaning-making.',
  '',
  '## 1. Beyond Automation',
  '',
  'Automation excels at well-defined tasks. But many valuable activities remain resistant to full automation.',
  '',
  '## 2. Complement, Do not Compete',
  '',
  'The goal is not to compete with AI, but to work with it.',
  ''
].join('\n')

function locate (quoted: string): { from: number, to: number } {
  const from = SCENE_WORKING_TEXT.indexOf(quoted)
  if (from < 0) {
    throw new Error(`Scene fixture text does not contain: ${quoted}`)
  }
  return { from, to: from + quoted.length }
}

const BASE_TIME = Date.parse('2026-05-20T10:00:00.000Z')

function at (minutesAfterBase: number): string {
  return new Date(BASE_TIME + minutesAfterBase * 60_000).toISOString()
}

export const SCENE_ANNOTATION_THREAD_ID = 'annotation-thread'
export const SCENE_ANNOTATION_PROPOSAL_ID = 'annotation-proposal'
export const SCENE_ANNOTATION_RESOLVED_ID = 'annotation-resolved'

export function buildSceneAnnotations (): TextAnnotation[] {
  const threadTarget = locate('framing problems, judgment, empathy, and meaning-making.')
  const proposalTarget = locate('resistant to full automation.')
  const resolvedTarget = locate('work with it.')

  const thread: TextAnnotation = {
    annotationId: SCENE_ANNOTATION_THREAD_ID,
    documentId: SCENE_DOCUMENT_ID,
    anchor: { state: 'range', ...threadTarget, quotedText: 'framing problems, judgment, empathy, and meaning-making.' },
    state: 'open',
    messages: [
      { messageId: 'msg-1', author: 'owner', text: 'Do we have examples of tasks that remain resistant? Add sources.', createdAt: at(0) },
      {
        messageId: 'msg-2',
        author: 'agent',
        clientRequestId: 'agent-reply-1',
        text: 'Yes. Tasks requiring contextual judgment, ethical reasoning, and novel problem framing remain hard to automate.',
        createdAt: at(2)
      }
    ],
    proposalActions: [],
    createdAt: at(0),
    updatedAt: at(2)
  }

  const proposal: TextAnnotation = {
    annotationId: SCENE_ANNOTATION_PROPOSAL_ID,
    documentId: SCENE_DOCUMENT_ID,
    anchor: { state: 'range', ...proposalTarget, quotedText: 'resistant to full automation.' },
    state: 'open',
    messages: [
      { messageId: 'msg-3', author: 'owner', text: 'Automation is not the whole story — push back on this framing.', createdAt: at(10) },
      {
        messageId: 'msg-4',
        author: 'agent',
        clientRequestId: 'agent-reply-2',
        text: 'Added a sentence with a citation to support the pushback.',
        createdAt: at(11)
      }
    ],
    proposalActions: [
      { actionId: 'action-1', packetId: 'packet-1', reviewId: 'review-1', linkedAt: at(11) }
    ],
    createdAt: at(10),
    updatedAt: at(11)
  }

  const resolved: TextAnnotation = {
    annotationId: SCENE_ANNOTATION_RESOLVED_ID,
    documentId: SCENE_DOCUMENT_ID,
    anchor: { state: 'range', ...resolvedTarget, quotedText: 'work with it.' },
    state: 'resolved',
    messages: [
      { messageId: 'msg-5', author: 'owner', text: 'Collaboration over competition — this line lands well already.', createdAt: at(20) }
    ],
    proposalActions: [],
    createdAt: at(20),
    updatedAt: at(21),
    resolvedAt: at(21)
  }

  return [thread, proposal, resolved]
}

export function buildSceneSession (): DocumentCollaborationSession {
  return {
    documentId: SCENE_DOCUMENT_ID,
    documentPath: SCENE_DOCUMENT_PATH,
    workingText: SCENE_WORKING_TEXT,
    workingSha256: SCENE_WORKING_SHA256,
    annotations: { generation: 1, items: buildSceneAnnotations() },
    review: undefined
  }
}

export const SCENE_WORKING_SHA256 = 'a'.repeat(64)
export const SCENE_REVIEW_ID = 'review-scene'
export const SCENE_REVIEW_GENERATION = 4
export const SCENE_CHUNK_TASKS_ID = 'suggestion-tasks'
export const SCENE_CHUNK_GOAL_ID = 'suggestion-goal'
export const SCENE_CHUNK_GOAL_NOTE = 'Check this against the published erratum first.'

/**
 * Two outstanding suggestions over the SAME working text the annotations
 * above anchor into — a replacement early in the document and one late, so
 * the panel's chunk order and line locators are both observable. One of them
 * already carries a reviewer note, which is what proves the note field is
 * prefilled from the provider rather than starting empty.
 */
export function buildSceneReview (): ReviewDiffSession {
  const tasks = locate('well-defined tasks')
  const goal = locate('to work with it')
  return {
    id: SCENE_REVIEW_ID,
    reviewGeneration: SCENE_REVIEW_GENERATION,
    documentPath: SCENE_DOCUMENT_PATH,
    workingText: SCENE_WORKING_TEXT,
    suggestions: [
      {
        suggestionId: SCENE_CHUNK_TASKS_ID,
        removedText: 'narrow tasks',
        anchors: [tasks],
        seam: tasks.from,
        description: 'Say which tasks automation actually handles.'
      },
      {
        suggestionId: SCENE_CHUNK_GOAL_ID,
        removedText: 'to replace it',
        anchors: [goal],
        seam: goal.from,
        description: 'Frame the goal as collaboration, not replacement.'
      }
    ],
    chunkComments: [{ chunkId: SCENE_CHUNK_GOAL_ID, comment: SCENE_CHUNK_GOAL_NOTE }]
  }
}

/** The same document, with an active review alongside its annotations. */
export function buildSceneSessionWithReview (): DocumentCollaborationSession {
  return { ...buildSceneSession(), review: buildSceneReview() }
}
