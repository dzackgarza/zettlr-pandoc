<template>
  <div
    id="annotations-panel"
    role="tabpanel"
    class="annotations-tab"
    v-bind:data-inspector-mode="collaborationStore.inspectorMode"
  >
    <AnnotationHeader
      v-bind:open-count="openCount"
      v-bind:query="filterQuery"
      v-on:update:query="filterQuery = $event"
    ></AnnotationHeader>

    <AnnotationList
      v-bind:cards="filteredCards"
      v-bind:show-resolved="collaborationStore.showResolved"
      v-bind:selected-id="collaborationStore.selectedAnnotationId"
      v-on:select="collaborationStore.selectAnnotation($event)"
      v-on:jump-to-line="emit('jump-to-line', $event)"
      v-on:toggle-resolved="collaborationStore.toggleShowResolved()"
    ></AnnotationList>

    <AnnotationInspector
      v-if="selectedCard !== undefined"
      v-bind:card="selectedCard"
      v-on:close="collaborationStore.selectAnnotation(null)"
      v-on:back="collaborationStore.selectAnnotation(null)"
      v-on:jump-to-line="emit('jump-to-line', $event)"
      v-on:reply="onReply"
      v-on:show-proposal="emit('show-proposal', selectedCard.annotation)"
      v-on:begin-reattach="emit('begin-reattach', selectedCard.annotation.annotationId)"
      v-on:resolve-toggle="onResolveToggle"
    ></AnnotationInspector>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationsTab
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     M7's root: a right-sidebar tab holding the compact list
 *                  above the detail inspector (S1/S3), fed exclusively from
 *                  useDocumentCollaborationStore — never a second read of
 *                  the sidecar (plan section 6). Container queries on this
 *                  root switch between the wide arrangement (list and
 *                  detail both visible, mockup 4) and the narrow
 *                  arrangement (one at a time, with the inspector's back
 *                  button, structural gate scene 11) — see the style block.
 *
 * END HEADER
 */

import { computed, ref, watch } from 'vue'
import AnnotationHeader from './annotations/AnnotationHeader.vue'
import AnnotationList from './annotations/AnnotationList.vue'
import AnnotationInspector from './annotations/AnnotationInspector.vue'
import { buildAnnotationCards, filterCards, openAnnotationCount, type AnnotationCardView } from './annotations/annotation-panel-model'
import { useDocumentCollaborationStore, useDocumentTreeStore } from 'source/pinia'
import type { TextAnnotation } from '@dts/common/annotation-domain'

const emit = defineEmits<{
  (e: 'jump-to-line', line: number): void
  (e: 'show-proposal', annotation: TextAnnotation): void
  (e: 'begin-reattach', annotationId: string): void
}>()

const collaborationStore = useDocumentCollaborationStore()
const documentTreeStore = useDocumentTreeStore()

const activeFile = computed(() => documentTreeStore.lastLeafActiveFile)
const filterQuery = ref('')

const session = computed(() => activeFile.value === undefined ? undefined : collaborationStore.getSession(activeFile.value.path))
const annotations = computed(() => session.value?.annotations.items ?? [])
const openCount = computed(() => openAnnotationCount(annotations.value))

const cards = computed(() => buildAnnotationCards(annotations.value, session.value?.workingText ?? ''))
const filteredCards = computed(() => filterCards(cards.value, filterQuery.value))
const selectedCard = computed<AnnotationCardView | undefined>(() => {
  const id = collaborationStore.selectedAnnotationId
  return id === null ? undefined : cards.value.find(card => card.annotation.annotationId === id)
})

watch(activeFile, file => {
  if (file !== undefined) {
    collaborationStore.ensureSession(file.path).catch(err => console.error('[AnnotationsTab] Could not load the collaboration session', err))
  }
}, { immediate: true })

function onReply (text: string): void {
  const path = activeFile.value?.path
  const annotationId = collaborationStore.selectedAnnotationId
  if (path === undefined || annotationId === null) {
    return
  }
  collaborationStore.addAnnotationMessage(path, annotationId, text)
    .catch(err => console.error('[AnnotationsTab] Could not send the reply', err))
}

function onResolveToggle (): void {
  const path = activeFile.value?.path
  const annotation = selectedCard.value?.annotation
  if (path === undefined || annotation === undefined) {
    return
  }
  const call = annotation.state === 'open'
    ? collaborationStore.resolveAnnotation(path, annotation.annotationId)
    : collaborationStore.reopenAnnotation(path, annotation.annotationId)
  call.catch(err => console.error('[AnnotationsTab] Could not change the annotation resolution', err))
}
</script>

<style lang="less">
body {
  .annotations-tab {
    container-type: inline-size;
    container-name: annotations-panel;
    display: flex;
    flex-direction: column;
  }
}

// Narrow sidebar (structural gate scene 11): show one pane at a time behind
// a back button rather than the wide stacked arrangement. The list/detail
// split itself never changes — only how many of the two are visible at once.
@container annotations-panel (max-width: 400px) {
  .annotations-tab[data-inspector-mode="detail"] .annotation-list { display: none; }
  .annotations-tab[data-inspector-mode="list"] .annotation-inspector { display: none; }
  .annotation-inspector-back { display: inline-flex !important; }
}
</style>
