<template>
  <div
    class="annotation-inspector"
    data-annotation-detail
    v-bind:data-annotation-id="card.annotation.annotationId"
  >
    <div class="annotation-inspector-header">
      <button
        type="button"
        class="annotation-icon-button annotation-inspector-back"
        v-bind:title="trans('Back to the annotation list')"
        v-bind:aria-label="trans('Back to the annotation list')"
        v-on:click="emit('back')"
      >
        <cds-icon
          shape="arrow"
          direction="left"
          role="presentation"
        ></cds-icon>
      </button>
      <span class="annotation-inspector-eyebrow annotation-muted">{{ eyebrowLabel }}</span>
      <span
        class="annotation-lifecycle-pill"
        v-bind:class="card.annotation.state"
      >{{ lifecycleLabel }}</span>
      <button
        type="button"
        class="annotation-icon-button annotation-inspector-close"
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

    <section class="annotation-card annotation-inspector-source">
      <div class="annotation-card-row">
        <span class="annotation-card-label">{{ trans('Selected text') }}</span>
        <button
          v-if="card.lineNumber !== undefined"
          type="button"
          class="annotation-line-locator"
          v-on:click="emit('jump-to-line', card.lineNumber)"
        >{{ lineLabel }}</button>
        <span
          v-else
          class="annotation-muted"
        >{{ card.lineLocator }}</span>
      </div>
      <blockquote class="annotation-selected-quote">{{ card.quotedText }}</blockquote>
    </section>

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
      v-bind:document-name="documentName"
      v-on:submit="emit('reply', $event)"
    ></AnnotationComposer>

    <div class="annotation-inspector-actions">
      <button
        v-if="actionRow.canReattach"
        type="button"
        class="annotation-button annotation-action-reattach"
        v-on:click="emit('begin-reattach')"
      >
        <cds-icon
          shape="paperclip"
          role="presentation"
        ></cds-icon> {{ trans('Reattach') }}
      </button>
      <button
        type="button"
        class="annotation-button annotation-button-primary annotation-inspector-resolve"
        v-on:click="emit('resolve-toggle')"
      >
        <cds-icon
          shape="check"
          role="presentation"
        ></cds-icon> {{ resolveLabel }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationInspector
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The detail half of the panel (S3): everything the owner
 *                  reads or clicks about ONE annotation lives here — the
 *                  selected text card, the thread, the linked proposal card
 *                  (if any, with its one "Show diff" affordance), the
 *                  always-visible composer and the bottom action row (S8:
 *                  Reattach when the anchor is orphaned, and the one
 *                  primary Resolve). Reattach only emits an intent:
 *                  recovering an anchor needs a fresh editor selection,
 *                  which this panel does not own, so it never calls
 *                  reattachAnnotation itself (I6 — a visible action, never
 *                  a background guess, and never one this panel could
 *                  fabricate a range for).
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed } from 'vue'
import type { DateTime } from 'luxon'
import AnnotationThread from './AnnotationThread.vue'
import AnnotationComposer from './AnnotationComposer.vue'
import ProposalActionCard from './ProposalActionCard.vue'
import { deriveActionRow, type AnnotationCardView } from './annotation-panel-model'

const props = defineProps<{
  card: AnnotationCardView
  now: DateTime
  /** The active document's name, for the composer's context chip. */
  documentName?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'back'): void
  (e: 'jump-to-line', line: number): void
  (e: 'reply', text: string): void
  (e: 'show-proposal'): void
  (e: 'begin-reattach'): void
  (e: 'resolve-toggle'): void
}>()

const actionRow = computed(() => deriveActionRow(props.card.annotation))
const lifecycleLabel = computed(() => props.card.annotation.state === 'resolved' ? trans('Resolved') : trans('Open'))
const eyebrowLabel = computed(() => trans('Annotation %s', String(props.card.ordinal)))
const lineLabel = computed(() => {
  const { lineNumber, endLineNumber } = props.card
  if (lineNumber === undefined || endLineNumber === undefined || endLineNumber <= lineNumber) {
    return trans('Line %s', String(lineNumber))
  }
  return trans('Lines %s–%s', String(lineNumber), String(endLineNumber))
})
const resolveLabel = computed(() => actionRow.value.resolveLabel === 'Reopen' ? trans('Reopen') : trans('Resolve'))
</script>

<style lang="less">
body {
  .annotation-inspector {
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
    padding: var(--annotation-gap) 0;
    border-top: 1px solid var(--annotation-border);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .annotation-inspector-header {
    display: flex;
    align-items: center;
    gap: 6px;

    .annotation-inspector-back { display: none; }

    .annotation-inspector-eyebrow {
      flex: 1 1 auto;
    }
  }

  .annotation-inspector-source {
    display: flex;
    flex-direction: column;
    gap: 6px;

    .annotation-selected-quote {
      position: relative;
      margin: 0;
      padding: 6px 8px 6px 24px;
      border: 1px solid var(--annotation-border);
      border-radius: 6px;
      background-color: var(--annotation-surface-muted);

      &::before {
        content: '“';
        position: absolute;
        left: 8px;
        top: 2px;
        font-size: 18px;
        line-height: 1;
        color: var(--annotation-text-muted);
      }
    }
  }

  .annotation-inspector-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
}
</style>
