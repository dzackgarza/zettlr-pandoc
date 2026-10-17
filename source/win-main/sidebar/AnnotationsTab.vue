<template>
  <div
    id="annotations-panel"
    class="annotations-tab workspace-annotations-tab"
  >
    <AnnotationHeader
      v-bind:outstanding-count="collaborationStore.workspaceUnresolvedCount"
      v-bind:accept-all-count="outstandingSuggestionCount"
      v-bind:resolve-all-count="workspaceOpenCount"
      v-bind:query="filterQuery"
      v-bind:busy="globalAcceptBusy || globalBulkBusy"
      v-on:update:query="filterQuery = $event"
      v-on:accept-all="acceptAllWorkspace"
      v-on:resolve-all="resolveAllWorkspace"
      v-on:close="emit('close')"
    ></AnnotationHeader>

    <p
      v-if="groups.length === 0"
      class="annotation-workspace-empty annotation-muted"
    >
      {{ trans('No pending annotations or proposed changes in this workspace.') }}
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
          {{ trans('%s pending', String(group.annotations.length + group.suggestions.length)) }}
        </span>
        <button
          v-if="group.openCount > 0"
          type="button"
          class="annotation-button annotation-document-resolve-acted"
          v-bind:title="trans('Resolve every open annotation of this document.')"
          v-bind:disabled="globalBulkBusy || bulkDocuments.has(group.documentPath)"
          v-on:click="resolveAllDocument(group.documentPath)"
        >{{ trans('Resolve all') }}</button>
        <button
          v-if="group.resolvedCount > 0"
          type="button"
          class="annotation-button annotation-document-clear-resolved"
          v-bind:title="trans('Delete every resolved annotation of this document.')"
          v-bind:disabled="globalBulkBusy || bulkDocuments.has(group.documentPath)"
          v-on:click="clearTarget = group.documentPath"
        >{{ trans('Clear resolved') }}</button>
        <button
          v-if="group.suggestions.length > 0 && !group.frozen"
          type="button"
          class="annotation-button annotation-document-accept-all"
          v-bind:disabled="globalAcceptBusy || acceptingDocuments.has(group.documentPath)"
          v-on:click="acceptAllDocument(group.documentPath)"
        >{{ trans('Accept all') }}</button>
      </header>

      <div
        v-if="group.frozen"
        class="annotation-frozen-review"
      >
        <p class="annotation-frozen-reason">
          {{ trans('The file changed on disk after this review opened, so its suggestions are frozen.') }}
        </p>
        <div class="annotation-frozen-actions">
          <button
            type="button"
            class="annotation-button annotation-frozen-reapply"
            v-bind:title="trans('Map the suggestions onto the current text. Suggestions whose text is gone are withdrawn.')"
            v-bind:disabled="recoveringDocuments.has(group.documentPath)"
            v-on:click="recover(group.documentPath, 'reapply')"
          >{{ trans('Reapply') }}</button>
          <button
            type="button"
            class="annotation-button annotation-frozen-return"
            v-bind:title="trans('Ask the agent to reapply the review or submit its changes again.')"
            v-bind:disabled="recoveringDocuments.has(group.documentPath)"
            v-on:click="recover(group.documentPath, 'return')"
          >{{ trans('Return to agent') }}</button>
          <button
            type="button"
            class="annotation-button annotation-frozen-discard"
            v-bind:title="trans('Remove the review. The file keeps its text.')"
            v-bind:disabled="recoveringDocuments.has(group.documentPath)"
            v-on:click="recover(group.documentPath, 'discard')"
          >{{ trans('Discard') }}</button>
        </div>
      </div>

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
          <span class="annotation-workspace-copy">
            <div
              v-annotation-markdown="card.instructionText"
              class="annotation-workspace-summary"
            />
            <div
              v-if="card.quotedText.length > 0"
              v-annotation-markdown="card.quotedText"
              class="annotation-workspace-context"
            />
          </span>
          <span
            class="annotation-lifecycle-pill"
            :class="card.annotation.agentStatus.state"
          >{{ card.annotation.agentStatus.state === 'acted' ? trans('Acted') : trans('Open') }}</span>
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
          <span class="annotation-workspace-copy">
            <span class="annotation-workspace-summary">{{ suggestion.description }}</span>
            <span
              v-if="suggestion.contextText.length > 0"
              class="annotation-workspace-context"
            >“{{ suggestion.contextText }}”</span>
          </span>
        </button>
      </div>
    </section>

    <!--
      Clearing the resolved annotations deletes their threads for good, like
      the single Delete asks first.
    -->
    <AlertDialogRoot v-model:open="clearDialogOpen">
      <AlertDialogPortal>
        <AlertDialogOverlay class="annotation-dialog-backdrop"></AlertDialogOverlay>
        <AlertDialogContent class="annotation-dialog">
          <AlertDialogTitle class="annotation-dialog-title">{{
            trans('Delete every resolved annotation?')
          }}</AlertDialogTitle>
          <AlertDialogDescription class="annotation-dialog-body">
            {{
              trans(
                "The document's resolved threads are deleted for good. This cannot be undone.",
              )
            }}
          </AlertDialogDescription>
          <div class="annotation-dialog-actions">
            <AlertDialogCancel class="annotation-button">{{ trans('Cancel') }}</AlertDialogCancel>
            <AlertDialogAction
              class="annotation-button annotation-button-danger"
              v-on:click="clearResolvedDocument(clearTarget)"
            >{{ trans('Delete') }}</AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
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
 *                  document. Rows are navigation only: a row opens its
 *                  document at the target, and an annotation row also opens
 *                  that annotation's thread there. Every single decision,
 *                  note and reply happens in the editor, under the change or
 *                  the annotated text. Rows lead with the full owner reason
 *                  or proposal claim and never duplicate navigation metadata
 *                  or the diff. Each document owns an Accept all action and
 *                  the panel header owns the workspace-wide one.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast from "@common/util/show-toast";
import type { SourceRange } from "@dts/common/references";
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import type {
  AnnotationFailure,
  ReviewFailure,
} from "source/app/service-providers/documents/document-collaboration-application-service";
import { useDocumentCollaborationStore } from "source/pinia";
import { computed, reactive, ref, watch } from "vue";
import { vAnnotationMarkdown } from "../editor-collaboration/annotation-markdown";
import AnnotationHeader from "./annotations/AnnotationHeader.vue";
import {
  type AnnotationCardView,
  buildSuggestionNavigatorRows,
  describeAcceptFailures,
  filterCards,
  openAnnotationCount,
  resolvedAnnotationCount,
  type SuggestionNavigatorView,
} from "./annotations/annotation-panel-model";

interface WorkspaceAnnotationGroup {
  documentPath: string;
  documentName: string;
  annotations: AnnotationCardView[];
  suggestions: SuggestionNavigatorView[];
  /** The review is frozen: see ReviewDiffSession.frozenText. */
  frozen: boolean;
  /** Open annotations: the per-document Resolve all. */
  openCount: number;
  /** Resolved annotations: the per-document Clear resolved. */
  resolvedCount: number;
}

const props = defineProps<{
  workspacePaths: string[];
}>();

const emit = defineEmits<{
  (
    e: "navigate",
    target: { documentPath: string; range?: SourceRange; annotationId?: string },
  ): void;
  (e: "close"): void;
}>();

const collaborationStore = useDocumentCollaborationStore();
const filterQuery = ref("");
const globalAcceptBusy = ref(false);
const acceptingDocuments = reactive(new Set<string>());
const recoveringDocuments = reactive(new Set<string>());
const globalBulkBusy = ref(false);
const bulkDocuments = reactive(new Set<string>());
/** The document whose resolved annotations the confirmation dialog is open for. */
const clearTarget = ref<string | null>(null);
const clearDialogOpen = computed({
  get: () => clearTarget.value !== null,
  set: (open: boolean) => {
    if (!open) {
      clearTarget.value = null;
    }
  },
});

function bulkBusy(documentPath: string): boolean {
  return globalBulkBusy.value || bulkDocuments.has(documentPath);
}

watch(
  () => props.workspacePaths,
  (paths) => {
    collaborationStore
      .refreshWorkspaceSessions(paths)
      .catch((err) =>
        reportError("[AnnotationsTab] Could not load workspace collaboration state", err),
      );
  },
  { immediate: true },
);

const normalizedFilter = computed(() => filterQuery.value.trim().toLowerCase());

const groups = computed<WorkspaceAnnotationGroup[]>(() =>
  collaborationStore.workspaceSessions
    .map((session) => {
      const annotations = filterCards(
        collaborationStore
          .getCards(session.documentPath)
          .filter((card) => card.annotation.state === "open"),
        filterQuery.value,
      );
      const suggestions = (
        session.review === undefined ? [] : buildSuggestionNavigatorRows(session.review)
      ).filter(
        (card) =>
          normalizedFilter.value.length === 0 ||
          card.description.toLowerCase().includes(normalizedFilter.value),
      );
      return {
        documentPath: session.documentPath,
        documentName: pathBasename(session.documentPath),
        annotations,
        suggestions,
        frozen: session.review?.frozenText !== undefined,
        /** The open threads this document's header can bulk-resolve. */
        openCount: openAnnotationCount(session.annotations.items),
        /** The resolved threads this document's header can bulk-delete. */
        resolvedCount: resolvedAnnotationCount(session.annotations.items),
      };
    })
    .filter((group) => group.annotations.length > 0 || group.suggestions.length > 0)
    .sort(
      (left, right) =>
        left.documentName.localeCompare(right.documentName) ||
        left.documentPath.localeCompare(right.documentPath),
    ),
);

const workspaceOpenCount = computed(() =>
  collaborationStore.workspaceSessions.reduce(
    (count, session) => count + openAnnotationCount(session.annotations.items),
    0,
  ),
);

const outstandingSuggestionCount = computed(() =>
  collaborationStore.workspaceSessions.reduce(
    (count, session) =>
      count +
      (session.review === undefined || session.review.frozenText !== undefined
        ? 0
        : session.review.suggestions.length),
    0,
  ),
);

function annotationRange(card: AnnotationCardView): SourceRange | undefined {
  const anchor = card.annotation.anchor;
  if (anchor.state === "range") {
    return { from: anchor.from, to: anchor.to };
  }
  if (anchor.state === "point") {
    return { from: anchor.at, to: anchor.at };
  }
  return undefined;
}

function navigate(documentPath: string, range?: SourceRange): void {
  emit("navigate", { documentPath, range });
}

function navigateAnnotation(documentPath: string, card: AnnotationCardView): void {
  emit("navigate", {
    documentPath,
    range: annotationRange(card),
    annotationId: card.annotation.annotationId,
  });
}

/** Shows which documents an Accept all could not accept, and why. */
function reportAcceptFailures(failures: Array<{ path: string; result: ReviewFailure }>): void {
  const heading =
    failures.length === 1
      ? trans("Could not accept all changes in 1 document.")
      : trans("Could not accept all changes in %s documents.", String(failures.length));
  showToast(`${heading}\n${describeAcceptFailures(failures)}`, "error");
}

async function acceptAllDocument(documentPath: string): Promise<void> {
  if (acceptingDocuments.has(documentPath)) {
    return;
  }
  acceptingDocuments.add(documentPath);
  try {
    const result = await collaborationStore.acceptAllWorkspaceReviewChunks(documentPath);
    if (!result.ok) {
      reportAcceptFailures([{ path: documentPath, result }]);
    }
  } catch (err) {
    reportError("[AnnotationsTab] Could not accept document review", err);
  } finally {
    acceptingDocuments.delete(documentPath);
  }
}

/** Reapply, return or discard the frozen review of one document. */
async function recover(
  documentPath: string,
  action: "reapply" | "return" | "discard",
): Promise<void> {
  if (recoveringDocuments.has(documentPath)) {
    return;
  }
  recoveringDocuments.add(documentPath);
  try {
    if (action === "reapply") {
      const result = await collaborationStore.reapplyReview(documentPath);
      if (!result.ok) {
        showToast(`${pathBasename(documentPath)}: ${result.message}`, "error");
      } else if (result.withdrawnChunkIds.length > 0) {
        showToast(
          trans(
            "%s suggestions no longer match the text and were withdrawn.",
            String(result.withdrawnChunkIds.length),
          ),
          "info",
        );
      }
      return;
    }
    const result =
      action === "return"
        ? await collaborationStore.returnReview(documentPath)
        : await collaborationStore.discardReview(documentPath);
    if (!result.ok) {
      showToast(`${pathBasename(documentPath)}: ${result.message}`, "error");
    }
  } catch (err) {
    reportError("[AnnotationsTab] Could not recover the review", err);
  } finally {
    recoveringDocuments.delete(documentPath);
  }
}

async function acceptAllWorkspace(): Promise<void> {
  if (globalAcceptBusy.value) {
    return;
  }
  globalAcceptBusy.value = true;
  try {
    const results = await collaborationStore.acceptAllWorkspaceReviews();
    const failures = results.flatMap(({ path, result }) => (result.ok ? [] : [{ path, result }]));
    if (failures.length > 0) {
      reportAcceptFailures(failures);
    }
  } catch (err) {
    reportError("[AnnotationsTab] Could not accept workspace reviews", err);
  } finally {
    globalAcceptBusy.value = false;
  }
}

/** Toasts one document's bulk refusal with the reason nothing changed. */
function reportBulkFailure(documentPath: string, result: AnnotationFailure): void {
  showToast(`${pathBasename(documentPath)}: ${result.message}`, "error");
}

/** Resolves every open annotation of one document, in one batch. */
async function resolveAllDocument(documentPath: string): Promise<void> {
  if (bulkBusy(documentPath)) {
    return;
  }
  bulkDocuments.add(documentPath);
  try {
    const result = await collaborationStore.resolveOpenAnnotations(documentPath);
    if ("ok" in result) {
      reportBulkFailure(documentPath, result);
    }
  } catch (err) {
    reportError("[AnnotationsTab] Could not resolve the open annotations", err);
  } finally {
    bulkDocuments.delete(documentPath);
  }
}

/** Deletes every resolved annotation of one document, after the confirmation. */
async function clearResolvedDocument(documentPath: string | null): Promise<void> {
  if (documentPath === null || bulkBusy(documentPath)) {
    return;
  }
  bulkDocuments.add(documentPath);
  clearTarget.value = null;
  try {
    const result = await collaborationStore.deleteResolvedAnnotations(documentPath);
    if ("ok" in result) {
      reportBulkFailure(documentPath, result);
    }
  } catch (err) {
    reportError("[AnnotationsTab] Could not clear the resolved annotations", err);
  } finally {
    bulkDocuments.delete(documentPath);
  }
}

/** Workspace-wide: every open annotation of the projected documents. */
async function resolveAllWorkspace(): Promise<void> {
  if (globalBulkBusy.value) {
    return;
  }
  globalBulkBusy.value = true;
  try {
    const results = await collaborationStore.resolveOpenAnnotationsWorkspace();
    for (const { path, result } of results) {
      if ("ok" in result) {
        reportBulkFailure(path, result);
      }
    }
  } catch (err) {
    reportError("[AnnotationsTab] Could not resolve the open annotations", err);
  } finally {
    globalBulkBusy.value = false;
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

  .annotation-frozen-review {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    border-left: 3px solid var(--annotation-warning);
    border-radius: 4px;
    background: var(--annotation-surface-muted);
  }

  .annotation-frozen-reason {
    margin: 0;
    font-size: var(--annotation-small-font-size);
  }

  .annotation-frozen-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
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

  .annotation-workspace-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .annotation-workspace-summary,
  .annotation-workspace-context {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .annotation-workspace-context {
    color: var(--annotation-text-muted);
    font-size: var(--annotation-small-font-size);
  }

  .annotation-header-spacer {
    flex: 1 1 auto;
  }
}
</style>
