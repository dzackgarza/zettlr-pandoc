<template>
  <div class="annotation-list">
    <p
      v-if="open.length === 0"
      class="annotation-list-empty annotation-muted"
    >
      {{ trans('No open annotations in this document.') }}
    </p>
    <AnnotationListItem
      v-for="card in open"
      v-bind:key="card.annotation.annotationId"
      v-bind:card="card"
      v-bind:selected="card.annotation.annotationId === selectedId"
      v-bind:now="now"
      v-on:select="emit('select', $event)"
      v-on:jump-to-line="emit('jump-to-line', $event)"
    ></AnnotationListItem>

    <button
      v-if="resolved.length > 0"
      type="button"
      class="annotation-resolved-disclosure"
      v-on:click="emit('toggle-resolved')"
    >
      <cds-icon
        shape="angle"
        v-bind:direction="showResolved ? 'down' : 'right'"
        role="presentation"
      ></cds-icon>
      {{ resolvedDisclosureLabel }}
    </button>

    <template v-if="showResolved">
      <AnnotationListItem
        v-for="card in resolved"
        v-bind:key="card.annotation.annotationId"
        v-bind:card="card"
        v-bind:selected="card.annotation.annotationId === selectedId"
        v-bind:now="now"
        v-on:select="emit('select', $event)"
        v-on:jump-to-line="emit('jump-to-line', $event)"
      ></AnnotationListItem>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationList
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The compact list half of the panel (S1/S3). Resolved
 *                  cards are partitioned out of the primary list entirely
 *                  and sit behind the "View resolved (N)" disclosure (S9) —
 *                  they are never interleaved with open cards regardless of
 *                  their document-order ordinal.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed } from 'vue'
import type { DateTime } from 'luxon'
import AnnotationListItem from './AnnotationListItem.vue'
import { partitionByResolution, type AnnotationCardView } from './annotation-panel-model'

const props = defineProps<{
  cards: AnnotationCardView[]
  showResolved: boolean
  selectedId: string | null
  now: DateTime
}>()

const emit = defineEmits<{
  (e: 'select', annotationId: string): void
  (e: 'jump-to-line', line: number): void
  (e: 'toggle-resolved'): void
}>()

const partitioned = computed(() => partitionByResolution(props.cards))
const open = computed(() => partitioned.value.open)
const resolved = computed(() => partitioned.value.resolved)
const resolvedDisclosureLabel = computed(() => trans('View resolved (%s)', String(resolved.value.length)))
</script>

<style lang="less">
body {
  .annotation-list {
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
    padding: var(--annotation-gap) 0;
  }

  .annotation-list-empty {
    margin: 0;
    padding: 4px 0;
  }

  button.annotation-resolved-disclosure {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 4px 0;
    border: none;
    background: transparent;
    color: var(--annotation-text-muted);
    font: inherit;
    font-size: var(--annotation-small-font-size);
    cursor: pointer;
    text-align: left;

    &:hover {
      color: var(--annotation-text);
    }

    cds-icon {
      width: 12px;
      height: 12px;
    }
  }
}
</style>
