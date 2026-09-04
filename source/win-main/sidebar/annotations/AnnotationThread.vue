<template>
  <div class="annotation-thread">
    <div
      v-for="message in messages"
      v-bind:key="message.messageId"
      class="annotation-message"
      v-bind:class="message.author"
    >
      <div class="annotation-message-meta">
        <span class="annotation-message-author">{{ authorLabel(message.author) }}</span>
        <span class="annotation-message-time">{{ formatTimestamp(message.createdAt) }}</span>
      </div>
      <p class="annotation-message-text">{{ message.text }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationThread
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The multi-turn conversation (S6): owner-first,
 *                  alternating. The owner's first message IS the
 *                  instruction — there is no separate title or instruction
 *                  field rendered here, only the thread.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import type { AnnotationMessage } from '@dts/common/annotation-domain'

defineProps<{
  messages: AnnotationMessage[]
}>()

function authorLabel (author: AnnotationMessage['author']): string {
  return author === 'owner' ? trans('You') : trans('AI')
}

function formatTimestamp (iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<style lang="less">
body {
  .annotation-thread {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 8px 0;
  }

  .annotation-message {
    padding: 6px 8px;
    border-radius: 6px;
    background-color: rgba(0, 0, 0, 0.04);

    &.agent { background-color: rgba(76, 141, 202, 0.08); }

    .annotation-message-meta {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      opacity: 0.65;
      margin-bottom: 2px;
    }

    .annotation-message-text {
      margin: 0;
      font-size: 12px;
      white-space: pre-wrap;
    }
  }

  &.dark .annotation-message {
    background-color: rgba(255, 255, 255, 0.06);
    &.agent { background-color: rgba(76, 141, 202, 0.15); }
  }
}
</style>
