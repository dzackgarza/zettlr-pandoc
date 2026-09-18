<template>
  <div
    id="annotations-panel"
    class="annotations-tab workspace-annotations-tab"
  >
    <AnnotationHeader
      v-bind:outstanding-count="collaborationStore.workspaceUnresolvedCount"
      v-bind:accept-all-count="outstandingSuggestionCount"
      v-bind:query="filterQuery"
      v-bind:busy="globalAcceptBusy"
      v-on:update:query="filterQuery = $event"
      v-on:accept-all="acceptAllWorkspace"
      v-on:close="emit('close')"
    ></AnnotationHeader>

    <p
      v-if="groups.length === 0"
      class="annotation-workspace-empty annotation-muted"
    >
      {{ trans('No outstanding annotations or proposed changes in this workspace.') }}
    </p>

    <section
      v-for="group in groups"
      v-bind:key="group.documentPath"
      class="annotation-document-group"
      v-bind:data-document-path="group.documentPath"
    >
      <header class="annotation-document-header">
        <button
          type="button"
          class="annotation-document-name"
          v-bind:title="group.documentPath"
          v-on:click="navigate(group.documentPath)"
        >{{ group.documentName }}</button>
        <span class="annotation-document-count annotation-muted">
          {{ trans('%s outstanding', String(group.annotations.length + group.suggestions.length)) }}
        </span>
        <button
          v-if="group.suggestions.length > 0"
          type="button"
          class="annotation-button annotation-document-accept-all"
          v-bind:disabled="globalAcceptBusy || acceptingDocuments.has(group.documentPath)"
          v-on:click="acceptAllDocument(group.documentPath)"
        >{{ trans('Accept all') }}</button>
      </header>

      <div class="annotation-document-items">
        <button
          v-for="card in group.annotations"
          v-bind:key="card.annotation.annotationId"
          type="button"
          class="annotation-workspace-row annotation-workspace-annotation"
          v-bind:data-annotation-id="card.annotation.annotationId"
          v-on:click="navigateAnnotation(group.documentPath, card)"
        >
          <span class="annotation-ordinal">{{ card.ordinal }}</span>
          <span class="annotation-line-locator">{{ card.lineLocator }}</span>
          <span class="annotation-workspace-kind">{{ trans('Annotation') }}</span>
          <span class="annotation-workspace-summary">{{ card.instructionText }}</span>
        </button>

        <button
          v-for="suggestion in group.suggestions"
          v-bind:key="suggestion.suggestionId"
          type="button"
          class="annotation-workspace-row annotation-workspace-suggestion"
          v-bind:data-suggestion-id="suggestion.suggestionId"
          v-on:click="navigate(group.documentPath, suggestion.range)"
        >
          <cds-icon shape="wand" role="presentation"></cds-icon>
          <span class="annotation-line-locator">{{ suggestion.lineLocator }}</span>
          <span class="annotation-workspace-kind">{{ trans('Change') }}</span>
          <span class="annotation-workspace-summary">{{ suggestion.description }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace annotations panel
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Workspace-wide outstanding collaboration work, grouped by
 *                  document. Rows are navigation only: annotation details and
 *                  review changes are read in the document itself. Review
 *                  suggestions therefore show identity/claim/line here but
 *                  never duplicate the diff. Each document owns an Accept all
 *                  action and the panel header owns the workspace-wide one.
 *
 * END HEADER
 */

import { computed, reactive, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import { reportError } from '@common/util/error-reporting'
import showToast from '@common/util/show-toast'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import type { SourceRange } from '@dts/common/references'
import AnnotationHeader from './annotations/AnnotationHeader.vue'
import {
  buildSuggestionNavigatorRows,
  filterCards,
  type AnnotationCardView,
  type SuggestionNavigatorView
} from './annotations/annotation-panel-model'
import { useDocumentCollaborationStore } from 'source/pinia'

interface WorkspaceAnnotationGroup {
  documentPath: string
  documentName: string
  annotations: AnnotationCardView[]
  suggestions: SuggestionNavigatorView[]
}

const props = defineProps<{
  workspacePaths: string[]
}>()

const emit = defineEmits<{
  (e: 'navigate', target: { documentPath: string, range?: SourceRange }): void
  (e: 'close'): void
}>()

const collaborationStore = useDocumentCollaborationStore()
const filterQuery = ref('')
const globalAcceptBusy = ref(false)
const acceptingDocuments = reactive(new Set<string>())

watch(() => props.workspacePaths, paths => {
  collaborationStore.refreshWorkspaceSessions(paths)
    .catch(err => reportError('[AnnotationsTab] Could not load workspace collaboration state', err))
}, { immediate: true })

const normalizedFilter = computed(() => filterQuery.value.trim().toLowerCase())

const groups = computed<WorkspaceAnnotationGroup[]>(() => collaborationStore.workspaceSessions
  .map(session => {
    const annotations = filterCards(
      collaborationStore.getCards(session.documentPath)
        .filter(card => card.annotation.state === 'open'),
      filterQuery.value
    )
    const suggestions = (session.review === undefined ? [] : buildSuggestionNavigatorRows(session.review))
      .filter(card => normalizedFilter.value.length === 0 ||
        card.description.toLowerCase().includes(normalizedFilter.value))
    return {
      documentPath: session.documentPath,
      documentName: pathBasename(session.documentPath),
      annotations,
      suggestions
    }
  })
  .filter(group => group.annotations.length > 0 || group.suggestions.length > 0)
  .sort((left, right) => left.documentName.localeCompare(right.documentName) ||
    left.documentPath.localeCompare(right.documentPath)))

const outstandingSuggestionCount = computed(() => collaborationStore.workspaceSessions
  .reduce((count, session) => count + (session.review?.suggestions.length ?? 0), 0))

function annotationRange (card: AnnotationCardView): SourceRange | undefined {
  const anchor = card.annotation.anchor
  if (anchor.state === 'range') {
    return { from: anchor.from, to: anchor.to }
  }
  if (anchor.state === 'point') {
    return { from: anchor.at, to: anchor.at }
  }
  return undefined
}

function navigate (documentPath: string, range?: SourceRange): void {
  emit('navigate', { documentPath, range })
}

function navigateAnnotation (documentPath: string, card: AnnotationCardView): void {
  navigate(documentPath, annotationRange(card))
}

async function acceptAllDocument (documentPath: string): Promise<void> {
  if (acceptingDocuments.has(documentPath)) {
    return
  }
  acceptingDocuments.add(documentPath)
  try {
    const result = await collaborationStore.acceptAllWorkspaceReviewChunks(documentPath)
    if (!result.ok) {
      showToast(trans(result.message), 'error')
    }
  } catch (err) {
    reportError('[AnnotationsTab] Could not accept document review', err)
  } finally {
    acceptingDocuments.delete(documentPath)
  }
}

async function acceptAllWorkspace (): Promise<void> {
  if (globalAcceptBusy.value) {
    return
  }
  globalAcceptBusy.value = true
  try {
    const results = await collaborationStore.acceptAllWorkspaceReviews()
    const failures = results.filter(({ result }) => !result.ok)
    if (failures.length > 0) {
      showToast(
        trans('Could not accept all changes in %s document(s).', String(failures.length)),
        'error'
      )
    }
  } catch (err) {
    reportError('[AnnotationsTab] Could not accept workspace reviews', err)
  } finally {
    globalAcceptBusy.value = false
  }
}
</script>

<style lang="less">
@import './annotations/annotation-panel.less';

body {
  .workspace-annotations-tab {
    container-type: inline-size;
    container-name: annotations-panel;
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 10px;
    box-sizing: border-box;
    overflow-y: auto;
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .annotation-workspace-empty {
    padding: 12px 0;
    margin: 0;
  }

  .annotation-document-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 0;
    border-bottom: 1px solid var(--annotation-border);
  }

  .annotation-document-header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .annotation-document-name {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    border: none;
    background: transparent;
    color: var(--annotation-text);
    font: inherit;
    font-weight: 600;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .annotation-document-count {
    flex: 0 0 auto;
    font-size: var(--annotation-small-font-size);
  }

  .annotation-document-accept-all {
    flex: 0 0 auto;
  }

  .annotation-document-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .annotation-workspace-row {
    display: grid;
    content-visibility: auto;
    contain-intrinsic-size: auto 28px;
    grid-template-columns: auto auto auto minmax(0, 1fr);
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 28px;
    padding: 4px 6px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--annotation-text);
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:hover {
      background: var(--annotation-surface-muted);
    }

    > cds-icon {
      width: 14px;
      height: 14px;
      color: var(--annotation-text-muted);
    }
  }

  .annotation-workspace-kind,
  .annotation-line-locator {
    color: var(--annotation-text-muted);
    font-size: var(--annotation-small-font-size);
    white-space: nowrap;
  }

  .annotation-workspace-summary {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .annotation-header-spacer {
    flex: 1 1 auto;
  }
}
</style>
