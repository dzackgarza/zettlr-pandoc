<template>
  <div class="annotation-card annotation-composer">
    <textarea
      v-model="draft"
      class="annotation-composer-input"
      rows="2"
      v-bind:placeholder="placeholder"
      v-on:keydown="onKeydown"
    ></textarea>
    <div class="annotation-composer-row">
      <span
        v-if="documentName !== undefined"
        class="annotation-chip annotation-composer-context"
      >{{ contextLabel }}</span>
      <span class="annotation-composer-spacer"></span>
      <span class="annotation-composer-send-group">
        <ShortcutDisplay
          class="annotation-composer-hint"
          v-bind:shortcut="sendShortcut"
          display="muted"
        ></ShortcutDisplay>
        <button
          type="button"
          class="annotation-icon-button annotation-composer-send"
          v-bind:title="sendLabel"
          v-bind:aria-label="sendLabel"
          v-bind:disabled="submission === undefined"
          v-on:click="submit"
        >
          <cds-icon
            shape="circle-arrow"
            direction="right"
            role="presentation"
          ></cds-icon>
        </button>
      </span>
    </div>
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
 * Description:     The owner's always-visible input at the bottom of the
 *                  detail (S8). Mod-Enter or the send icon submits the
 *                  trimmed draft; Escape clears it. Submitting never mutates
 *                  the panel's own state; it emits the text, and the caller
 *                  sends it over IPC (documentCollaborationStore
 *                  .addAnnotationMessage) — the message appears in the
 *                  thread only once the resulting broadcast lands.
 *
 * END HEADER
 */

import { computed, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import ShortcutDisplay from '@common/vue/ShortcutDisplay.vue'
import { explodeAccelerator } from '@common/util/shortcuts'
import { composerSubmission } from './annotation-presentation'

const props = defineProps<{
  /** The document the reply belongs to, shown as the context chip. */
  documentName?: string
}>()

const emit = defineEmits<(e: 'submit', text: string) => void>()

const placeholder = trans('Ask a question or request changes…')
const sendLabel = trans('Send')
// Cmd on macOS, Ctrl elsewhere — the same pair onKeydown accepts.
const sendShortcut = explodeAccelerator('CmdOrCtrl+Enter')

const draft = ref('')
const submission = computed(() => composerSubmission(draft.value))
const contextLabel = computed(() => trans('Context: %s', props.documentName))

function submit (): void {
  const text = submission.value
  if (text === undefined) {
    return
  }
  emit('submit', text)
  draft.value = ''
}

function onKeydown (event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    submit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    draft.value = ''
  }
}
</script>

<style lang="less">
body {
  .annotation-composer {
    display: flex;
    flex-direction: column;
    gap: 6px;

    &:focus-within {
      border-color: var(--annotation-accent);
    }

    .annotation-composer-input {
      box-sizing: border-box;
      width: 100%;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--annotation-text);
      font: inherit;
      font-size: var(--annotation-font-size);
      resize: vertical;
      outline: none;

      &::placeholder {
        color: var(--annotation-text-muted);
      }
    }

    .annotation-composer-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .annotation-composer-context {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .annotation-composer-spacer {
      flex: 1 1 auto;
    }

    .annotation-composer-send-group {
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      gap: 6px;
    }

    .annotation-composer-hint {
      color: var(--annotation-text-muted);
      font-size: var(--annotation-small-font-size);
    }

    .annotation-composer-send:not(:disabled) {
      color: var(--annotation-accent);
    }
  }
}
</style>
