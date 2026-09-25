<template>
  <div
    class="suggestion-chunk"
    v-bind:data-chunk-id="card.suggestionId"
  >
    <cds-icon
      class="suggestion-chunk-glyph"
      shape="wand"
      role="presentation"
    ></cds-icon>
    <span class="suggestion-chunk-description">{{ card.description }}</span>
    <div class="suggestion-chunk-actions">
      <input
        ref="noteField"
        v-model="draft"
        type="text"
        class="suggestion-chunk-comment"
        v-bind:placeholder="trans('Comment…')"
        v-bind:title="trans('Add a note without accepting or rejecting this change. Clear the field to remove the note.')"
        v-bind:disabled="busy"
        v-on:keydown.enter.prevent="commitNote"
        v-on:blur="commitNote"
      >
      <button
        type="button"
        class="annotation-button suggestion-decision accept"
        v-bind:title="trans('Accept this change')"
        v-bind:disabled="busy"
        v-on:click="emit('decide', card.suggestionId, 'accept')"
      >
        <cds-icon
          shape="check"
          role="presentation"
        ></cds-icon>
        {{ trans('Accept') }}
      </button>
      <button
        type="button"
        class="annotation-button suggestion-decision reject"
        v-bind:title="trans('Reject this change')"
        v-bind:disabled="busy"
        v-on:click="emit('decide', card.suggestionId, 'reject')"
      >
        <cds-icon
          shape="times"
          role="presentation"
        ></cds-icon>
        {{ trans('Reject') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewChunkControls
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The block under one review chunk in the editor: the claim
 *                  that proposed the change, the chunk's note field, and
 *                  Accept and Reject. The change itself is the struck and
 *                  highlighted text right above it, so nothing here repeats
 *                  it.
 *
 *                  Nothing here mutates collaboration state: each action is
 *                  emitted, the host sends it over IPC, and the provider's
 *                  broadcast is the only thing that redraws this block.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { ref, watch } from 'vue'
import { chunkNoteCommit, type SuggestionCardView } from '../sidebar/annotations/annotation-panel-model'

const props = defineProps<{
  card: SuggestionCardView
  /** True while a review action from this pane is in flight: every control
   *  locks for the round trip, so a second click cannot land on a chunk the
   *  first one already decided. */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'decide', chunkId: string, decision: 'accept' | 'reject'): void
  (e: 'comment-chunk', chunkId: string, text: string): void
}>()

const noteField = ref<HTMLInputElement | null>(null)

/**
 * The note field, seeded from the provider's note. Every commit is a review
 * mutation whose broadcast re-renders this block while the owner may still
 * be typing; re-seeding the focused field would overwrite those unsent
 * characters, so only an unfocused field takes the provider's value.
 */
const draft = ref(props.card.comment)
watch(() => props.card.comment, comment => {
  if (document.activeElement !== noteField.value) {
    draft.value = comment
  }
})

function commitNote (): void {
  const text = chunkNoteCommit(props.card, draft.value)
  if (text !== undefined) {
    emit('comment-chunk', props.card.suggestionId, text)
  }
}
</script>

<style lang="less">
@import '../sidebar/annotations/annotation-panel.less';

body {
  .suggestion-chunk {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    padding: 6px 8px;
    border-left: 3px solid var(--annotation-agent);
    border-radius: 0 6px 6px 0;
    background-color: var(--annotation-surface-muted);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .suggestion-chunk-glyph {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    color: var(--annotation-agent);
  }

  .suggestion-chunk-description {
    flex: 1 1 16em;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .suggestion-chunk-actions {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  input.suggestion-chunk-comment {
    box-sizing: border-box;
    width: 14em;
    min-width: 6em;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--annotation-border);
    border-radius: 6px;
    background: var(--annotation-surface);
    color: var(--annotation-text);
    font: inherit;
    font-size: var(--annotation-small-font-size);

    &:focus {
      outline: 2px solid var(--annotation-accent-muted);
    }
  }

  button.suggestion-decision.accept {
    border-color: transparent;
    background-color: var(--annotation-resolved);
    color: var(--annotation-accent-contrast);

    &:hover:not(:disabled) {
      background-color: var(--annotation-resolved);
      opacity: 0.9;
    }
  }

  button.suggestion-decision.reject {
    color: var(--annotation-danger);
  }
}
</style>
