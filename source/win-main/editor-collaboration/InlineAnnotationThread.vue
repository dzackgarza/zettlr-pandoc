<template>
  <div
    class="annotation-inline-thread"
    data-annotation-detail
    v-bind:data-annotation-id="card.annotation.annotationId"
    v-bind:class="card.annotation.state"
  >
    <div class="annotation-inline-thread-header">
      <span class="annotation-ordinal">{{ card.ordinal }}</span>
      <span
        class="annotation-lifecycle-pill"
        v-bind:class="card.annotation.state"
      >{{ lifecycleLabel }}</span>
      <span class="annotation-inline-thread-spacer"></span>
      <button
        type="button"
        class="annotation-icon-button annotation-inline-thread-close"
        v-bind:title="trans('Close')"
        v-bind:aria-label="trans('Close')"
        v-on:click="emit('close')"
      >
        <cds-icon
          shape="times"
          role="presentation"
        ></cds-icon>
      </button>
    </div>

    <!-- A live target is highlighted right above this thread; only a lost
         one needs its text spelled out, since nothing marks it any more. -->
    <blockquote
      v-if="actionRow.canReattach"
      class="annotation-selected-quote"
    >{{ card.quotedText }}</blockquote>

    <AnnotationThread
      v-bind:messages="card.annotation.messages"
      v-bind:now="now"
    ></AnnotationThread>

    <ProposalActionCard
      v-if="card.annotation.proposalActions.length > 0"
      v-bind:actions="card.annotation.proposalActions"
      v-on:show-proposal="emit('show-proposal')"
    ></ProposalActionCard>

    <AnnotationComposer
      v-on:submit="emit('reply', $event)"
    ></AnnotationComposer>

    <div class="annotation-inline-thread-actions">
      <button
        type="button"
        class="annotation-button annotation-action-delete"
        data-annotation-action="delete"
        v-on:click="confirmingDelete = true"
      >
        <cds-icon
          shape="trash"
          role="presentation"
        ></cds-icon> {{ trans('Delete') }}
      </button>
      <button
        v-if="actionRow.canReattach"
        type="button"
        class="annotation-button annotation-action-reattach"
        data-annotation-action="reattach"
        v-bind:title="trans('Select the new target text in the document, then click here')"
        v-on:mousedown.prevent
        v-on:click="emit('begin-reattach')"
      >
        <cds-icon
          shape="paperclip"
          role="presentation"
        ></cds-icon> {{ trans('Reattach') }}
      </button>
      <button
        type="button"
        class="annotation-button annotation-button-primary annotation-inline-thread-resolve"
        data-annotation-action="resolve"
        v-on:click="emit('resolve-toggle')"
      >
        <cds-icon
          shape="check"
          role="presentation"
        ></cds-icon> {{ resolveLabel }}
      </button>
    </div>

    <!--
      Resolving keeps the thread; deleting takes the annotation, its thread
      and its proposals away for good, and nothing brings them back. So it
      asks.
    -->
    <AlertDialogRoot v-model:open="confirmingDelete">
      <AlertDialogPortal>
        <AlertDialogOverlay class="annotation-dialog-backdrop"></AlertDialogOverlay>
        <AlertDialogContent class="annotation-dialog">
          <AlertDialogTitle class="annotation-dialog-title">{{ trans('Delete this annotation?') }}</AlertDialogTitle>
          <AlertDialogDescription class="annotation-dialog-body">
            {{ trans('Its thread and any proposed changes go with it. This cannot be undone.') }}
          </AlertDialogDescription>
          <div class="annotation-dialog-actions">
            <AlertDialogCancel class="annotation-button">{{ trans('Cancel') }}</AlertDialogCancel>
            <AlertDialogAction
              class="annotation-button annotation-button-danger"
              data-annotation-confirm="delete"
              v-on:click="emit('delete')"
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
 * Contains:        InlineAnnotationThread
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One annotation's thread, opened in the editor under the
 *                  text it targets (the editor comment-widget pattern): the
 *                  conversation, the linked proposal card with its "Show
 *                  diff" affordance, the reply composer, and the action row —
 *                  Delete, Reattach while the target is lost, and the one
 *                  primary Resolve. Delete asks first, because it takes the
 *                  thread with it, while Resolve keeps everything.
 *
 *                  Reattach only emits an intent: the replacement range is
 *                  the owner's current editor selection, which the pane
 *                  owns, so this never fabricates a range (I6). Its
 *                  mousedown is swallowed so pressing it does not disturb
 *                  that selection.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed, ref } from 'vue'
import type { DateTime } from 'luxon'
import AnnotationThread from './AnnotationThread.vue'
import AnnotationComposer from './AnnotationComposer.vue'
import ProposalActionCard from './ProposalActionCard.vue'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle
} from 'reka-ui'
import { deriveActionRow, type AnnotationCardView } from '../sidebar/annotations/annotation-panel-model'

const props = defineProps<{
  card: AnnotationCardView
  now: DateTime
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reply', text: string): void
  (e: 'show-proposal'): void
  (e: 'begin-reattach'): void
  (e: 'resolve-toggle'): void
  (e: 'delete'): void
}>()

/** Whether the delete confirmation is up. */
const confirmingDelete = ref(false)

const actionRow = computed(() => deriveActionRow(props.card.annotation))
const lifecycleLabel = computed(() => props.card.annotation.state === 'resolved' ? trans('Resolved') : trans('Open'))
const resolveLabel = computed(() => actionRow.value.resolveLabel === 'Reopen' ? trans('Reopen') : trans('Resolve'))
</script>

<style lang="less">
@import '../sidebar/annotations/annotation-panel.less';

body {
  .annotation-inline-thread {
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
    max-width: 42em;
    padding: 8px 10px;
    border: 1px solid var(--annotation-border);
    border-left: 3px solid var(--annotation-accent);
    border-radius: 0 var(--annotation-radius) var(--annotation-radius) 0;
    background-color: var(--annotation-surface);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);

    &.resolved {
      border-left-color: var(--annotation-resolved);
    }
  }

  .annotation-inline-thread-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .annotation-inline-thread-spacer {
    flex: 1 1 auto;
  }

  .annotation-selected-quote {
    margin: 0;
    padding: 6px 8px;
    border: 1px dashed var(--annotation-warning);
    border-radius: 6px;
    color: var(--annotation-text-muted);
  }

  .annotation-inline-thread-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  // Destructive, so it sits away from the primary action, not beside it.
  .annotation-action-delete {
    margin-right: auto;
    color: var(--annotation-danger);
  }

  .annotation-dialog-backdrop {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.35);
  }

  .annotation-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 16px;
    border: 1px solid var(--annotation-border);
    border-radius: var(--annotation-radius);
    background-color: var(--annotation-surface);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  }

  .annotation-dialog-title {
    margin: 0;
    font-size: var(--annotation-font-size);
    font-weight: 600;
  }

  .annotation-dialog-body {
    margin: 0;
    color: var(--annotation-text-muted);
  }

  .annotation-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
}
</style>
