<template>
  <Teleport
    v-for="block in blocks"
    v-bind:key="block.key"
    v-bind:to="block.dom"
  >
    <ReviewChunkControls
      v-if="block.control.kind === 'review-chunk' && chunkCards.has(block.control.chunkId)"
      v-bind:card="chunkCards.get(block.control.chunkId)!"
      v-bind:busy="reviewBusy"
      v-on:decide="decide"
      v-on:comment-chunk="commentChunk"
    ></ReviewChunkControls>
    <ReviewBar
      v-else-if="block.control.kind === 'review-bar' && review !== undefined"
      v-bind:pending-count="review.suggestions.length"
      v-bind:busy="reviewBusy"
      v-on:accept-all="runReviewAction(path => collaborationStore.acceptAllReviewChunks(path))"
      v-on:clear="runReviewAction(path => collaborationStore.clearReview(path))"
      v-on:comment="text => runReviewAction(path => collaborationStore.addReviewComment(path, text))"
      v-on:step="emit('step-chunk', $event)"
    ></ReviewBar>
    <InlineAnnotationThread
      v-else-if="block.control.kind === 'annotation-thread' && annotationCards.has(block.control.annotationId)"
      v-bind:card="annotationCards.get(block.control.annotationId)!"
      v-bind:now="now"
      v-on:close="collaborationStore.selectAnnotation(null)"
      v-on:reply="reply(block.control.annotationId, $event)"
      v-on:show-proposal="showProposal(annotationCards.get(block.control.annotationId)!)"
      v-on:begin-reattach="emit('reattach', block.control.annotationId)"
      v-on:resolve-toggle="toggleResolution(annotationCards.get(block.control.annotationId)!)"
      v-on:delete="deleteAnnotation(block.control.annotationId)"
    ></InlineAnnotationThread>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        InlineCollaborationControls
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Fills the blocks one editor pane places for its
 *                  document's collaboration state (see
 *                  markdown-editor/plugins/collaboration-controls.ts): the
 *                  controls under each review chunk, the review bar, and the
 *                  active annotation's thread. Each block is teleported
 *                  into the element the editor made for it, so the controls
 *                  sit in the document while staying ordinary components of
 *                  this window.
 *
 *                  Every action goes to useDocumentCollaborationStore, which
 *                  sends it over IPC with the fence of the cached session.
 *                  Nothing here changes collaboration state: the provider's
 *                  broadcast redraws the editor and these blocks. A refusal
 *                  is toasted so the owner reads why nothing changed.
 *                  Actions that need the editor itself (moving to a chunk,
 *                  reading the selection for Reattach) go to the pane.
 *
 * END HEADER
 */

import { computed, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import { reportError } from '@common/util/error-reporting'
import showToast from '@common/util/show-toast'
import type { CollaborationControl } from '@common/modules/markdown-editor/plugins/collaboration-controls'
import type { SourceRange } from '@dts/common/references'
import { useDocumentCollaborationStore } from 'source/pinia'
import type { ReviewFailure } from 'source/app/service-providers/documents/document-collaboration-application-service'
import {
  buildSuggestionCards,
  suggestionIdsForPacketIds,
  type AnnotationCardView,
  type SuggestionCardView
} from '../sidebar/annotations/annotation-panel-model'
import ReviewChunkControls from './ReviewChunkControls.vue'
import ReviewBar from './ReviewBar.vue'
import InlineAnnotationThread from './InlineAnnotationThread.vue'
import { useMinuteClock } from './use-minute-clock'

/** A block the editor placed, with the element to render it into. */
export interface CollaborationBlock {
  key: number
  dom: HTMLElement
  control: CollaborationControl
}

const props = defineProps<{
  documentPath: string
  blocks: CollaborationBlock[]
}>()

const emit = defineEmits<{
  (e: 'reveal-range', range: SourceRange): void
  (e: 'reattach', annotationId: string): void
  (e: 'step-chunk', direction: 1 | -1): void
}>()

const collaborationStore = useDocumentCollaborationStore()
const now = useMinuteClock()

const session = computed(() => collaborationStore.getSession(props.documentPath))
const review = computed(() => session.value?.review)

const chunkCards = computed(() => new Map<string, SuggestionCardView>(
  (review.value === undefined ? [] : buildSuggestionCards(review.value))
    .map(card => [card.suggestionId, card])
))

const annotationCards = computed(() => new Map<string, AnnotationCardView>(
  collaborationStore.getCards(props.documentPath)
    .map(card => [card.annotation.annotationId, card])
))

/**
 * True while a review action from this pane is in flight. Every review
 * control locks for the round trip, so two mass actions cannot run over one
 * partition and a second click cannot land on a chunk already decided.
 */
const reviewBusy = ref(false)

function runReviewAction (action: (path: string) => Promise<{ ok: true } | ReviewFailure>): void {
  if (reviewBusy.value) {
    return
  }
  reviewBusy.value = true
  action(props.documentPath)
    .then(result => {
      if (!result.ok) {
        showToast(trans(result.message), 'error')
      }
    })
    .catch(err => reportError('[InlineCollaborationControls] Could not send the review action', err))
    .finally(() => { reviewBusy.value = false })
}

function decide (chunkId: string, decision: 'accept' | 'reject'): void {
  runReviewAction(path => collaborationStore.decideReviewChunk(path, chunkId, decision))
}

function commentChunk (chunkId: string, text: string): void {
  runReviewAction(path => collaborationStore.commentReviewChunk(path, chunkId, text))
}

function reply (annotationId: string, text: string): void {
  collaborationStore.addAnnotationMessage(props.documentPath, annotationId, text)
    .then(result => {
      if ('ok' in result && !result.ok) {
        showToast(trans(result.message), 'error')
      }
    })
    .catch(err => reportError('[InlineCollaborationControls] Could not send the reply', err))
}

function toggleResolution (card: AnnotationCardView): void {
  const annotationId = card.annotation.annotationId
  const call = card.annotation.state === 'open'
    ? collaborationStore.resolveAnnotation(props.documentPath, annotationId)
    : collaborationStore.reopenAnnotation(props.documentPath, annotationId)
  call
    .then(result => {
      if ('ok' in result && !result.ok) {
        showToast(trans(result.message), 'error')
      }
    })
    .catch(err => reportError('[InlineCollaborationControls] Could not change the annotation resolution', err))
}

/**
 * The owner deleted the annotation. Its thread and chip leave the editor
 * through the provider's broadcast, like every other annotation mutation;
 * the selection is dropped here because the annotation it named is gone.
 */
function deleteAnnotation (annotationId: string): void {
  collaborationStore.deleteAnnotation(props.documentPath, annotationId)
    .then(result => {
      if ('ok' in result && !result.ok) {
        showToast(trans(result.message), 'error')
        return
      }
      collaborationStore.selectAnnotation(null)
    })
    .catch(err => reportError('[InlineCollaborationControls] Could not delete the annotation', err))
}

/**
 * S7: "Show diff" moves the editor to the first outstanding chunk the
 * annotation's linked proposals produced. Nothing is decided from here.
 */
function showProposal (card: AnnotationCardView): void {
  const currentReview = review.value
  if (currentReview === undefined) {
    return
  }
  const [chunkId] = suggestionIdsForPacketIds(
    currentReview,
    card.annotation.proposalActions.map(action => action.packetId)
  )
  const chunk = currentReview.suggestions.find(suggestion => suggestion.suggestionId === chunkId)
  if (chunk === undefined) {
    showToast(trans('Every change this annotation proposed has already been decided.'))
    return
  }
  const first = chunk.anchors[0] ?? { from: chunk.seam, to: chunk.seam }
  emit('reveal-range', { from: first.from, to: first.to })
}
</script>
