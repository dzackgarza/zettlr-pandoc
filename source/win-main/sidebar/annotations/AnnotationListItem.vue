<template>
  <div
    class="annotation-card annotation-list-item"
    v-bind:class="{ selected: selected, resolved: card.annotation.state === 'resolved' }"
    role="button"
    tabindex="0"
    v-bind:aria-selected="selected"
    v-on:click="emit('select', card.annotation.annotationId)"
    v-on:keydown.enter="emit('select', card.annotation.annotationId)"
  >
    <div class="annotation-card-row">
      <span
        class="annotation-ordinal"
        v-bind:data-ordinal="card.ordinal"
      >{{ card.ordinal }}</span>
      <button
        v-if="card.lineNumber !== undefined"
        type="button"
        class="annotation-line-locator"
        v-on:click.stop="emit('jump-to-line', card.lineNumber)"
      >{{ card.lineLocator }}</button>
      <span
        v-else
        class="annotation-line-locator-orphaned annotation-muted"
      >{{ card.lineLocator }}</span>
      <span class="annotation-card-spacer"></span>
      <span
        class="annotation-lifecycle-pill"
        v-bind:class="card.annotation.state"
      >{{ lifecycleLabel }}</span>
    </div>
    <p class="annotation-quoted-preview">“{{ card.quotedText }}”</p>
    <p class="annotation-title">{{ card.instructionPreview }}</p>
    <div class="annotation-card-row annotation-meta annotation-muted">
      <span class="annotation-card-author">{{ authorLabel }}</span>
      <span class="annotation-card-time">{{ relativeTime }}</span>
      <span
        v-if="card.wordCount > 0"
        class="annotation-card-words"
      >· {{ wordCountLabel }}</span>
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
 * Description:     One flat bordered card of the compact list (S5): the
 *                  ordinal the editor marker carries (S4), the line locator,
 *                  the lifecycle pill, the quoted target, the instruction
 *                  preview (derived from the first message every time, I8)
 *                  and the author and relative time of that message.
 *
 * END HEADER
 */

import { computed } from 'vue'
import type { DateTime } from 'luxon'
import { trans } from '@common/i18n-renderer'
import type { AnnotationCardView } from './annotation-panel-model'
import { formatRelative } from './annotation-presentation'

const props = defineProps<{
  card: AnnotationCardView
  selected: boolean
  now: DateTime
}>()

const emit = defineEmits<{
  (e: 'select', annotationId: string): void
  (e: 'jump-to-line', line: number): void
}>()

const justNow = trans('Just now')
const lifecycleLabel = computed(() => props.card.annotation.state === 'resolved' ? trans('Resolved') : trans('Open'))
const wordCountLabel = computed(() => trans('%s words', String(props.card.wordCount)))
const firstMessage = computed(() => props.card.annotation.messages[0])
const authorLabel = computed(() => firstMessage.value.author === 'owner' ? trans('You') : trans('AI'))
const relativeTime = computed(() => formatRelative(firstMessage.value.createdAt, props.now, justNow))
</script>

<style lang="less">
body {
  .annotation-list-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;

    &:hover {
      background-color: var(--annotation-surface-muted);
    }

    &.selected {
      border-color: var(--annotation-accent);
      background-color: var(--annotation-active-surface);
    }

    &.resolved {
      color: var(--annotation-text-muted);
    }

    .annotation-ordinal {
      flex-shrink: 0;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      box-sizing: border-box;
      border-radius: 4px;
      border: 1px solid var(--annotation-border);
      line-height: 16px;
      text-align: center;
      font-size: var(--annotation-small-font-size);
      font-weight: 600;
      color: var(--annotation-text-muted);
    }

    .annotation-card-spacer {
      flex: 1 1 auto;
    }

    .annotation-quoted-preview {
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--annotation-text-muted);
    }

    .annotation-title {
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .annotation-meta {
      gap: 4px;
    }

    .annotation-card-author {
      font-weight: 600;
    }
  }
}
</style>
