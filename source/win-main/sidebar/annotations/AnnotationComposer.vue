<template>
  <div class="annotation-composer">
    <textarea
      v-model="draft"
      class="annotation-composer-input"
      rows="2"
      v-bind:placeholder="placeholderLabel"
      v-on:keydown.enter.exact.prevent="submit"
    ></textarea>
    <button
      type="button"
      class="annotation-composer-send"
      v-bind:disabled="draft.trim().length === 0"
      v-on:click="submit"
    >{{ sendLabel }}</button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationComposer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The owner's reply box, revealed by the detail's Reply
 *                  action (S8). Submitting never mutates the panel's own
 *                  state; it emits the text, and the caller sends it over
 *                  IPC (documentCollaborationStore.addAnnotationMessage) —
 *                  the message appears in the thread only once the resulting
 *                  broadcast lands.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { ref } from 'vue'

const emit = defineEmits<(e: 'submit', text: string) => void>()

const draft = ref('')
const placeholderLabel = trans('Reply…')
const sendLabel = trans('Send')

function submit (): void {
  const text = draft.value.trim()
  if (text.length === 0) {
    return
  }
  emit('submit', text)
  draft.value = ''
}
</script>

<style lang="less">
body {
  .annotation-composer {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    margin: 8px 0;

    .annotation-composer-input {
      flex-grow: 1;
      box-sizing: border-box;
      resize: vertical;
      border-radius: 4px;
      border: 1px solid rgba(0, 0, 0, 0.15);
      padding: 4px 6px;
      font: inherit;
      font-size: 12px;
    }

    .annotation-composer-send {
      flex-shrink: 0;
      border: none;
      border-radius: 4px;
      padding: 5px 10px;
      background-color: var(--system-accent-color, #4c8dca);
      color: white;
      cursor: pointer;

      &:disabled { opacity: 0.5; cursor: default; }
    }
  }
}
</style>
