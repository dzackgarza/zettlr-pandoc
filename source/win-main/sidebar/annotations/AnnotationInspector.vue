<template>
  <div class="annotation-inspector" data-annotation-detail v-bind:data-annotation-id="card.annotation.annotationId">
    <div class="annotation-inspector-header">
      <button
        type="button"
        class="annotation-inspector-back"
        v-bind:title="backLabel"
        v-bind:aria-label="backLabel"
        v-on:click="emit('back')"
      >
        <cds-icon shape="arrow" direction="left" role="presentation"></cds-icon>
      </button>
      <span class="annotation-inspector-eyebrow">{{ eyebrowLabel }}</span>
      <span class="annotation-lifecycle-pill" v-bind:class="card.annotation.state">{{ lifecycleLabel }}</span>
      <button
        type="button"
        class="annotation-inspector-close"
        v-bind:title="closeLabel"
        v-bind:aria-label="closeLabel"
        v-on:click="emit('close')"
      >
        <cds-icon shape="times" role="presentation"></cds-icon>
      </button>
    </div>

    <section class="annotation-inspector-source">
      <h2>
        {{ sourceLabel }}
        <button
          v-if="card.lineNumber !== undefined"
          type="button"
          class="annotation-line-locator"
          v-on:click="emit('jump-to-line', card.lineNumber)"
        >{{ card.lineLocator }}</button>
        <span v-else>{{ card.lineLocator }}</span>
      </h2>
      <blockquote>“{{ card.quotedText }}”</blockquote>
    </section>

    <AnnotationThread v-bind:messages="card.annotation.messages"></AnnotationThread>

    <ProposalActionCard
      v-if="card.annotation.proposalActions.length > 0"
      v-bind:pending-count="pendingProposalCount"
      v-bind:total-count="card.annotation.proposalActions.length"
    ></ProposalActionCard>

    <AnnotationComposer
      v-if="replyOpen"
      v-on:submit="text => { emit('reply', text); replyOpen = false }"
    ></AnnotationComposer>

    <div class="annotation-inspector-actions">
      <button type="button" class="annotation-action-reply" v-on:click="replyOpen = !replyOpen">
        <cds-icon shape="undo" role="presentation"></cds-icon> {{ replyLabel }}
      </button>
      <button
        v-if="actionRow.canShowProposal"
        type="button"
        class="annotation-action-show-proposal"
        v-on:click="emit('show-proposal')"
      >
        <cds-icon shape="eye" role="presentation"></cds-icon> {{ showProposalLabel }}
      </button>
      <button
        v-if="actionRow.canReattach"
        type="button"
        class="annotation-action-reattach"
        v-on:click="emit('begin-reattach')"
      >
        <cds-icon shape="paperclip" role="presentation"></cds-icon> {{ reattachLabel }}
      </button>
      <button
        type="button"
        class="annotation-inspector-resolve"
        v-on:click="emit('resolve-toggle')"
      >
        <cds-icon shape="check" role="presentation"></cds-icon> {{ resolveLabel }}
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
 *                  source excerpt, the thread, the linked proposal (if any),
 *                  and the terminal action row (S8: Reply, Show proposal,
 *                  Reattach, Resolve — nothing else). Reattach only emits an
 *                  intent: recovering an anchor needs a fresh editor
 *                  selection, which this panel does not own, so it never
 *                  calls reattachAnnotation itself (I6 — a visible action,
 *                  never a background guess, and never one this panel could
 *                  fabricate a range for).
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed, ref } from 'vue'
import AnnotationThread from './AnnotationThread.vue'
import AnnotationComposer from './AnnotationComposer.vue'
import ProposalActionCard from './ProposalActionCard.vue'
import { deriveActionRow, type AnnotationCardView } from './annotation-panel-model'

const props = defineProps<{
  card: AnnotationCardView
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

const replyOpen = ref(false)

const actionRow = computed(() => deriveActionRow(props.card.annotation))
const pendingProposalCount = computed(() => props.card.annotation.proposalActions.filter(a => a.terminalOutcome === undefined).length)
const lifecycleLabel = computed(() => props.card.annotation.state === 'resolved' ? trans('Resolved') : trans('Open'))
const eyebrowLabel = computed(() => trans('Annotation %s', String(props.card.ordinal)))
const resolveLabel = computed(() => actionRow.value.resolveLabel === 'Reopen' ? trans('Reopen') : trans('Resolve'))

const backLabel = trans('Back to the annotation list')
const closeLabel = trans('Close')
const sourceLabel = trans('Source')
const replyLabel = trans('Reply')
const showProposalLabel = trans('Show proposal')
const reattachLabel = trans('Reattach')
</script>

<style lang="less">
body {
  .annotation-inspector {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border-top: 1px solid rgba(0, 0, 0, 0.1);
  }

  .annotation-inspector-header {
    display: flex;
    align-items: center;
    gap: 6px;

    .annotation-inspector-back { display: none; }

    .annotation-inspector-eyebrow {
      flex-grow: 1;
      font-size: 11px;
      font-weight: bold;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.7;
    }

    button {
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 2px;
      clr-icon, cds-icon { width: 14px; height: 14px; }
    }
  }

  .annotation-inspector-source {
    h2 {
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.6;
      margin: 6px 0 2px 0;
      display: flex;
      gap: 6px;
      align-items: baseline;
    }

    blockquote {
      margin: 0;
      padding: 6px 8px;
      border-left: 3px solid var(--system-accent-color, #4c8dca);
      background-color: rgba(0, 0, 0, 0.04);
      font-size: 12px;
    }
  }

  .annotation-line-locator {
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
  }

  .annotation-inspector-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 6px;
    margin-top: 4px;

    button {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: transparent;
      cursor: pointer;

      &:hover { background-color: rgba(0, 0, 0, 0.05); }
      clr-icon, cds-icon { width: 12px; height: 12px; }
    }

    .annotation-inspector-resolve {
      margin-left: auto;
      background-color: var(--system-accent-color, #4c8dca);
      color: white;
      border-color: transparent;

      &:hover { opacity: 0.9; }
    }
  }

  &.dark {
    .annotation-inspector { border-top-color: rgba(255, 255, 255, 0.15); }
    .annotation-inspector-source blockquote { background-color: rgba(255, 255, 255, 0.08); }
    .annotation-inspector-actions {
      border-top-color: rgba(255, 255, 255, 0.12);
      button { border-color: rgba(255, 255, 255, 0.18); }
      button:hover { background-color: rgba(255, 255, 255, 0.08); }
    }
  }
}
</style>
