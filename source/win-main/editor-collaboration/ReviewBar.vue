<template>
  <div class="suggestion-review-bar">
    <span class="suggestion-review-count">{{ pendingLabel }}</span>
    <button
      type="button"
      class="annotation-icon-button suggestion-review-previous"
      v-bind:title="trans('Previous change (Shift-F8)')"
      v-bind:aria-label="trans('Previous change')"
      v-on:click="emit('step', -1)"
    >
      <cds-icon
        shape="angle"
        direction="up"
        role="presentation"
      ></cds-icon>
    </button>
    <button
      type="button"
      class="annotation-icon-button suggestion-review-next"
      v-bind:title="trans('Next change (F8)')"
      v-bind:aria-label="trans('Next change')"
      v-on:click="emit('step', 1)"
    >
      <cds-icon
        shape="angle"
        direction="down"
        role="presentation"
      ></cds-icon>
    </button>
    <input
      v-model="reviewComment"
      type="text"
      class="suggestion-review-comment-input"
      v-bind:placeholder="trans('Review comment…')"
      v-bind:disabled="busy"
      v-on:keydown.enter.prevent="submitReviewComment"
    >
    <button
      type="button"
      class="annotation-button suggestion-review-comment-submit"
      v-bind:disabled="busy || reviewComment.trim().length === 0"
      v-on:click="submitReviewComment"
    >{{ trans('Comment') }}</button>
    <span class="suggestion-review-decisions">
      <button
        type="button"
        class="annotation-button suggestion-clear"
        v-bind:title="trans('Reject every change still pending in this document')"
        v-bind:disabled="busy"
        v-on:click="emit('clear')"
      >{{ trans('Reject all') }}</button>
      <button
        type="button"
        class="annotation-button annotation-button-primary suggestion-accept-all"
        v-bind:title="trans('Accept every change still pending in this document')"
        v-bind:disabled="busy"
        v-on:click="emit('accept-all')"
      >{{ trans('Accept all') }}</button>
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewBar
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The bar the editor shows at its bottom edge while a review
 *                  has changes pending: how many, stepping between them, the
 *                  review-level comment, and the two actions that name no
 *                  single chunk — Reject all and Accept all. Every action is
 *                  emitted; the host sends it and the provider's broadcast
 *                  redraws the bar.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed, ref } from 'vue'

const props = defineProps<{
  pendingCount: number
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'accept-all'): void
  (e: 'clear'): void
  (e: 'comment', text: string): void
  (e: 'step', direction: 1 | -1): void
}>()

const reviewComment = ref('')

const pendingLabel = computed(() => props.pendingCount === 1
  ? trans('1 change pending')
  : trans('%s changes pending', String(props.pendingCount)))

function submitReviewComment (): void {
  const text = reviewComment.value.trim()
  if (text.length === 0) {
    return
  }
  emit('comment', text)
  reviewComment.value = ''
}
</script>

<style lang="less">
@import '../sidebar/annotations/annotation-panel.less';

body {
  .suggestion-review-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--annotation-border);
    background-color: var(--annotation-surface);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .suggestion-review-count {
    font-weight: 600;
    white-space: nowrap;
  }

  input.suggestion-review-comment-input {
    box-sizing: border-box;
    flex: 1 1 8em;
    min-width: 6em;
    max-width: 24em;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--annotation-border);
    border-radius: 6px;
    background: var(--annotation-surface);
    color: var(--annotation-text);
    font: inherit;
    font-size: var(--annotation-small-font-size);
  }

  // Reject all and Accept all wrap as one unit, at the bar's far end.
  .suggestion-review-decisions {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
}
</style>
