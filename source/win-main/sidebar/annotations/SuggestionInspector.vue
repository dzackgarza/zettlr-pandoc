<template>
  <section class="suggestion-inspector" ref="root">
    <div class="suggestion-inspector-header">
      <span class="suggestion-inspector-eyebrow">{{ headingLabel }}</span>
      <span class="suggestion-outstanding">{{ outstandingLabel }}</span>
    </div>

    <div class="suggestion-inspector-mass-actions">
      <button
        type="button"
        class="suggestion-accept-all"
        v-bind:disabled="busy"
        v-on:click="emit('accept-all')"
      >{{ acceptAllLabel }}</button>
      <button
        type="button"
        class="suggestion-clear"
        v-bind:disabled="busy"
        v-on:click="emit('clear')"
      >{{ clearLabel }}</button>
    </div>

    <ol class="suggestion-chunk-list">
      <li
        v-for="card in cards"
        v-bind:key="card.suggestionId"
        class="suggestion-chunk"
        v-bind:class="{ 'suggestion-chunk-linked': focusedChunkIds.includes(card.suggestionId) }"
        v-bind:data-chunk-id="card.suggestionId"
      >
        <div class="suggestion-chunk-header">
          <button
            type="button"
            class="suggestion-line-locator"
            v-on:click="emit('jump-to-line', card.lineNumber)"
          >{{ card.lineLocator }}</button>
          <span class="suggestion-chunk-description">{{ card.description }}</span>
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
            v-bind:placeholder="commentPlaceholder"
            v-bind:title="commentTitle"
            v-bind:disabled="busy"
            v-on:keydown.enter.prevent="commitComment(card)"
            v-on:blur="commitComment(card)"
          >
          <button
            type="button"
            class="suggestion-decision accept"
            v-bind:disabled="busy"
            v-on:click="emit('decide', card.suggestionId, 'accept')"
          >{{ acceptLabel }}</button>
          <button
            type="button"
            class="suggestion-decision reject"
            v-bind:disabled="busy"
            v-on:click="emit('decide', card.suggestionId, 'reject')"
          >{{ rejectLabel }}</button>
        </div>
      </li>
    </ol>

    <div class="suggestion-review-comment">
      <input
        v-model="reviewComment"
        type="text"
        class="suggestion-review-comment-input"
        v-bind:placeholder="reviewCommentPlaceholder"
        v-bind:disabled="busy"
        v-on:keydown.enter.prevent="submitReviewComment"
      >
      <button
        type="button"
        class="suggestion-review-comment-submit"
        v-bind:disabled="busy || reviewComment.trim().length === 0"
        v-on:click="submitReviewComment"
      >{{ commentLabel }}</button>
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

const headingLabel = trans('Proposal')
const outstandingLabel = computed(() => trans('%s outstanding', String(props.review.suggestions.length)))
const acceptAllLabel = trans('Accept all')
const clearLabel = trans('Reject remaining')
const acceptLabel = trans('Accept')
const rejectLabel = trans('Reject')
const commentLabel = trans('Comment')
const commentPlaceholder = trans('Comment…')
const commentTitle = trans('Annotate this change without deciding it; clearing the field removes the note')
const reviewCommentPlaceholder = trans('Review comment…')

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
    gap: 6px;
    padding: 8px;
    border-top: 1px solid rgba(0, 0, 0, 0.1);
  }

  .suggestion-inspector-header {
    display: flex;
    align-items: baseline;
    gap: 6px;

    .suggestion-inspector-eyebrow {
      flex-grow: 1;
      font-size: 11px;
      font-weight: bold;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .suggestion-outstanding {
      font-size: 11px;
      opacity: 0.8;
    }
  }

  .suggestion-inspector-mass-actions {
    display: flex;
    gap: 4px;

    button {
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: transparent;
      color: inherit;
      cursor: pointer;

      &:hover:not(:disabled) { background-color: rgba(0, 0, 0, 0.05); }
      &:disabled { opacity: 0.5; cursor: default; }
    }
  }

  .suggestion-chunk-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  // The review palette. The editor's own copy of it lives in its CodeMirror
  // theme, which scopes to .cm-editor and never reaches this panel — so the
  // two are stated separately. They cannot drift on the decision colors,
  // because Accept and Reject exist in exactly one surface: this one.
  @review-delete-bg: rgba(207, 34, 46, 0.30);
  @review-insert-bg: rgba(26, 178, 74, 0.45);
  @review-accept-bg: #1f7a45;
  @review-reject-bg: #b33a3a;

  .suggestion-chunk {
    border-radius: 6px;
    background-color: rgba(0, 0, 0, 0.04);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    outline: 2px solid transparent;
    outline-offset: 2px;
    transition: outline-color 0.2s ease;

    p { margin: 0; font-size: 12px; }

    // S7: "Show proposal" landed here — the same accent the editor uses to
    // link a marker to its card (S4), so the connection reads consistently.
    &.suggestion-chunk-linked {
      outline-color: var(--system-accent-color, #4c8dca);
      background-color: rgba(76, 141, 202, 0.12);
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
    display: flex;
    gap: 6px;
    align-items: baseline;

    .suggestion-chunk-description {
      font-size: 11px;
      opacity: 0.75;
      font-style: italic;
    }
  }

  .suggestion-line-locator {
    flex-shrink: 0;
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    font-size: 11px;
    color: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
  }

  // The review-level comment is a different scope from a chunk note, so it
  // reads below a rule rather than as one more field in the chunk list.
  .suggestion-review-comment {
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 6px;
    margin-top: 2px;
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
      font-size: 12px;
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid rgba(0, 0, 0, 0.15);
      background: transparent;
      color: inherit;

      &:disabled { opacity: 0.5; }
    }

    button {
      flex-shrink: 0;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;

      &:disabled { opacity: 0.5; cursor: default; }
    }

    .suggestion-decision.accept {
      background-color: @review-accept-bg;
      color: white;
    }

    .suggestion-decision.reject {
      background-color: @review-reject-bg;
      color: white;
    }

    .suggestion-review-comment-submit {
      border-color: rgba(0, 0, 0, 0.12);
      background: transparent;
      color: inherit;
    }
  }

  &.dark {
    .suggestion-inspector { border-top-color: rgba(255, 255, 255, 0.15); }
    .suggestion-chunk { background-color: rgba(255, 255, 255, 0.07); }
    .suggestion-inspector-mass-actions button {
      border-color: rgba(255, 255, 255, 0.18);
      &:hover:not(:disabled) { background-color: rgba(255, 255, 255, 0.08); }
    }
    .suggestion-chunk-actions input,
    .suggestion-review-comment input { border-color: rgba(255, 255, 255, 0.2); }
    .suggestion-review-comment { border-top-color: rgba(255, 255, 255, 0.12); }
    .suggestion-review-comment-submit { border-color: rgba(255, 255, 255, 0.18); }
  }
}
</style>
