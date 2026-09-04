<template>
  <div
    class="annotation-list-item"
    v-bind:class="{ selected: selected, resolved: card.annotation.state === 'resolved' }"
    role="button"
    tabindex="0"
    v-bind:aria-selected="selected"
    v-on:click="emit('select', card.annotation.annotationId)"
    v-on:keydown.enter="emit('select', card.annotation.annotationId)"
  >
    <span class="annotation-ordinal" v-bind:data-ordinal="card.ordinal">{{ card.ordinal }}</span>
    <div class="annotation-list-item-body">
      <div class="annotation-list-item-title-row">
        <span class="annotation-title">{{ card.title }}</span>
        <span
          class="annotation-lifecycle-pill"
          v-bind:class="card.annotation.state"
        >{{ lifecycleLabel }}</span>
      </div>
      <div class="annotation-meta">
        <button
          v-if="card.lineNumber !== undefined"
          type="button"
          class="annotation-line-locator"
          v-on:click.stop="emit('jump-to-line', card.lineNumber)"
        >{{ card.lineLocator }}</button>
        <span v-else class="annotation-line-locator-orphaned">{{ card.lineLocator }}</span>
        <span v-if="card.wordCount > 0"> · {{ wordCountLabel }}</span>
      </div>
      <p class="annotation-quoted-preview">“{{ card.quotedText }}”</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationListItem
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One card of the compact list (S5): ordinal, title
 *                  (derived, never stored — I8), line locator, lifecycle
 *                  pill, and the quoted source. The instruction preview
 *                  lives in the detail inspector, not here — the list stays
 *                  compact per mockup 4.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed } from 'vue'
import type { AnnotationCardView } from './annotation-panel-model'

const props = defineProps<{
  card: AnnotationCardView
  selected: boolean
}>()

const emit = defineEmits<{
  (e: 'select', annotationId: string): void
  (e: 'jump-to-line', line: number): void
}>()

const lifecycleLabel = computed(() => props.card.annotation.state === 'resolved' ? trans('Resolved') : trans('Open'))
const wordCountLabel = computed(() => trans('%s words', String(props.card.wordCount)))
</script>

<style lang="less">
body {
  .annotation-list-item {
    display: flex;
    gap: 8px;
    padding: 8px;
    border-radius: 6px;
    cursor: pointer;
    align-items: flex-start;

    &:hover { background-color: rgba(0, 0, 0, 0.05); }
    &.selected { background-color: rgba(76, 141, 202, 0.12); outline: 1px solid var(--system-accent-color, #4c8dca); }
    &.resolved { opacity: 0.75; }

    .annotation-ordinal {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      line-height: 20px;
      border-radius: 50%;
      text-align: center;
      font-size: 11px;
      font-weight: bold;
      background-color: rgba(0, 0, 0, 0.08);
      color: inherit;
    }

    .annotation-list-item-body { flex-grow: 1; min-width: 0; }

    .annotation-list-item-title-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6px;

      .annotation-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .annotation-lifecycle-pill {
      flex-shrink: 0;
      font-size: 10px;
      padding: 1px 7px;
      border-radius: 999px;
      background-color: rgba(0, 0, 0, 0.08);

      &.resolved { background-color: rgba(60, 160, 90, 0.2); }
      &.open { background-color: rgba(76, 141, 202, 0.2); }
    }

    .annotation-meta {
      font-size: 11px;
      opacity: 0.7;
      margin: 2px 0;
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

    .annotation-quoted-preview {
      margin: 2px 0 0 0;
      font-size: 12px;
      font-style: italic;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  &.dark .annotation-list-item:hover { background-color: rgba(255, 255, 255, 0.08); }
}
</style>
