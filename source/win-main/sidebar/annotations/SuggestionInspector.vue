<template>
  <section class="suggestion-inspector" ref="root">
    <div class="suggestion-inspector-header">
      <span class="suggestion-inspector-title">{{ trans('Proposed changes') }}</span>
      <span class="annotation-chip suggestion-outstanding">{{ outstandingLabel }}</span>
      <span class="suggestion-inspector-spacer"></span>
      <div class="suggestion-inspector-mass-actions">
        <button
          type="button"
          class="annotation-button suggestion-accept-all"
          v-bind:disabled="busy"
          v-on:click="emit('accept-all')"
        >{{ trans('Accept all') }}</button>
        <button
          type="button"
          class="annotation-button suggestion-clear"
          v-bind:disabled="busy"
          v-on:click="emit('clear')"
        >{{ trans('Reject remaining') }}</button>
      </div>
    </div>

    <ol class="suggestion-chunk-list">
      <li
        v-for="card in cards"
        v-bind:key="card.suggestionId"
        class="annotation-card suggestion-chunk"
        v-bind:class="{ 'suggestion-chunk-linked': focusedChunkIds.includes(card.suggestionId) }"
        v-bind:data-chunk-id="card.suggestionId"
      >
        <div class="annotation-card-row suggestion-chunk-header">
          <button
            type="button"
            class="annotation-line-locator suggestion-line-locator"
            v-on:click="emit('jump-to-line', card.lineNumber)"
          >{{ card.lineLocator }}</button>
          <span class="suggestion-chunk-description annotation-muted">{{ card.description }}</span>
        </div>

        <p v-if="card.removedText !== ''" class="suggestion-removed">
          <del>{{ card.removedText }}</del>
        </p>
        <p v-if="card.insertedText !== ''" class="suggestion-inserted">
          <ins>{{ card.insertedText }}</ins>
        </p>

        <div class="suggestion-chunk-actions">
          <input
            v-model="drafts[card.suggestionId]"
            type="text"
            class="suggestion-chunk-comment"
            v-bind:placeholder="trans('Comment…')"
            v-bind:title="trans('Annotate this change without deciding it; clearing the field removes the note')"
            v-bind:disabled="busy"
            v-on:keydown.enter.prevent="commitComment(card)"
            v-on:blur="commitComment(card)"
          >
          <button
            type="button"
            class="annotation-button suggestion-decision accept"
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
      </li>
    </ol>

    <div class="suggestion-review-comment">
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
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SuggestionInspector
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Review adjudication, in the panel (M9 / S3). Every
 *                  control the in-editor chunk widgets and status bar used
 *                  to carry lives here: per-chunk Accept and Reject, the
 *                  per-chunk reviewer note, Accept all, Reject remaining,
 *                  and the review-level comment. The editor keeps the
 *                  locators alone (I4) — the struck-through deletion and the
 *                  highlighted insertion — so the owner reads WHERE a
 *                  proposal lands there and decides it here.
 *
 *                  Like every other control in this panel, nothing here
 *                  mutates collaboration state: each action is emitted, the
 *                  panel root sends it over IPC, and the resulting
 *                  DP_EVENTS.DOCUMENT_COLLABORATION broadcast is the only
 *                  thing that redraws this component.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed, nextTick, ref, watch } from 'vue'
import { buildSuggestionCards, chunkNoteCommit, type SuggestionCardView } from './annotation-panel-model'
import type { ReviewDiffSession } from '@dts/common/review-diff'

const props = withDefaults(defineProps<{
  review: ReviewDiffSession
  /** True while a mutation this component emitted is in flight. Every
   *  control locks for the round trip, so two sweeps cannot be launched over
   *  one partition and a second click cannot land on a chunk the first one
   *  already decided. */
  busy: boolean
  /** S7: the chunk ids AnnotationsTab wants surfaced right now — an
   *  annotation's linked proposal, opened via "Show proposal". Empty means
   *  nothing is currently pointed at. */
  focusedChunkIds?: string[]
}>(), {
  focusedChunkIds: () => []
})

const emit = defineEmits<{
  (e: 'decide', chunkId: string, decision: 'accept' | 'reject'): void
  (e: 'comment-chunk', chunkId: string, text: string): void
  (e: 'accept-all'): void
  (e: 'clear'): void
  (e: 'comment', text: string): void
  (e: 'jump-to-line', line: number): void
}>()

const cards = computed(() => buildSuggestionCards(props.review))
const reviewComment = ref('')
const root = ref<HTMLElement | null>(null)

/** Brings the first focused chunk on screen the moment AnnotationsTab names
 *  one — "Show proposal" is a navigation action (S7), not a silent flag. */
watch(() => props.focusedChunkIds, ids => {
  const target = ids[0]
  if (target === undefined) {
    return
  }
  nextTick()
    .then(() => {
      root.value
        ?.querySelector(`.suggestion-chunk[data-chunk-id="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    .catch(err => console.error('[SuggestionInspector] Could not scroll to the linked proposal', err))
})

const outstandingLabel = computed(() => trans('%s outstanding', String(props.review.suggestions.length)))

/** The note field of the chunk the reviewer is typing in right now, if any. */
function isBeingTypedIn (chunkId: string): boolean {
  const active = document.activeElement
  return active instanceof HTMLInputElement &&
    active.closest('.suggestion-chunk')?.getAttribute('data-chunk-id') === chunkId
}

/**
 * The note fields, seeded from the provider's own notes.
 *
 * Every commit is a review mutation, so its broadcast re-renders this
 * component while the reviewer may still have the field focused and may have
 * kept typing since. Re-seeding the focused field there would overwrite
 * those unsent characters, so the field the reviewer is in keeps its draft
 * and every other field takes the provider's value.
 */
const drafts = ref<Record<string, string>>({})
watch(cards, current => {
  const next: Record<string, string> = {}
  for (const card of current) {
    next[card.suggestionId] = isBeingTypedIn(card.suggestionId)
      ? drafts.value[card.suggestionId] ?? card.comment
      : card.comment
  }
  drafts.value = next
}, { immediate: true })

/** Commit a chunk note when the reviewer leaves the field or presses Enter. */
function commitComment (card: SuggestionCardView): void {
  const text = chunkNoteCommit(card, drafts.value[card.suggestionId] ?? '')
  if (text === undefined) {
    return
  }
  emit('comment-chunk', card.suggestionId, text)
}

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
body {
  .suggestion-inspector {
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
    padding: var(--annotation-gap) 0;
    border-top: 1px solid var(--annotation-border);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .suggestion-inspector-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;

    .suggestion-inspector-title {
      font-weight: 600;
    }

    .suggestion-inspector-spacer {
      flex: 1 1 auto;
    }
  }

  .suggestion-inspector-mass-actions {
    display: flex;
    gap: 4px;
  }

  .suggestion-chunk-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
  }

  // The diff palette. The editor's own copy of it lives in its CodeMirror
  // theme, which scopes to .cm-editor and never reaches this panel — so the
  // two are stated separately.
  @review-delete-bg: rgba(207, 34, 46, 0.30);
  @review-insert-bg: rgba(26, 178, 74, 0.45);

  .suggestion-chunk {
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color 0.2s ease, background-color 0.2s ease;

    p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    // S7: "Show diff" landed here — the same accent the editor uses to
    // link a marker to its card (S4), so the connection reads consistently.
    &.suggestion-chunk-linked {
      border-color: var(--annotation-accent);
      background-color: var(--annotation-active-surface);
    }

    del {
      background-color: @review-delete-bg;
      text-decoration-thickness: 2px;
    }

    ins {
      background-color: @review-insert-bg;
      text-decoration: none;
    }
  }

  .suggestion-chunk-header {
    align-items: baseline;

    .suggestion-chunk-description {
      min-width: 0;
      font-style: italic;
    }
  }

  // The review-level comment is a different scope from a chunk note, so it
  // reads below a rule rather than as one more field in the chunk list.
  .suggestion-review-comment {
    border-top: 1px solid var(--annotation-border);
    padding-top: var(--annotation-gap);
  }

  .suggestion-chunk-actions,
  .suggestion-review-comment {
    display: flex;
    align-items: center;
    gap: 4px;

    input {
      flex: 1 1 auto;
      min-width: 0;
      box-sizing: border-box;
      font: inherit;
      font-size: var(--annotation-small-font-size);
      padding: 4px 6px;
      border-radius: 6px;
      border: 1px solid var(--annotation-border);
      background: transparent;
      color: var(--annotation-text);

      &::placeholder {
        color: var(--annotation-text-muted);
      }

      &:disabled { opacity: 0.5; }
    }

    .annotation-button {
      flex-shrink: 0;
    }

    .suggestion-decision.accept {
      color: var(--annotation-resolved);
    }

    .suggestion-decision.reject {
      color: var(--annotation-warning);
    }
  }
}
</style>
