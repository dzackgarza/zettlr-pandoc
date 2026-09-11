<template>
  <div
    class="annotation-card proposal-action-card"
    v-bind:class="{ pending: view.pendingCount > 0 }"
  >
    <div class="annotation-card-row">
      <span class="annotation-card-label">{{ trans('Proposed changes') }}</span>
      <span
        class="annotation-chip proposal-count"
        v-bind:class="{ pending: view.pendingCount > 0 }"
      >{{ countLabel }}</span>
    </div>
    <div class="proposal-actions">
      <button
        type="button"
        class="annotation-button annotation-action-show-proposal"
        v-on:click="emit('show-proposal')"
      >
        <cds-icon
          shape="eye"
          role="presentation"
        ></cds-icon>
        {{ trans('Show diff') }}
      </button>
    </div>
    <p class="proposal-note annotation-muted">{{ noteLabel }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ProposalActionCard
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     S7: a proposal is a distinct element, not a message — a
 *                  count plus the one affordance to open it. "Show diff"
 *                  brings the linked chunks of the review surface below
 *                  into view; the proposal is never applied from here as an
 *                  inline edit — the owner adjudicates it in the suggestion
 *                  inspector.
 *
 * END HEADER
 */

import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'
import type { AnnotationProposalAction } from '@dts/common/annotation-domain'
import { proposalCardView } from './annotation-presentation'

const props = defineProps<{
  actions: readonly AnnotationProposalAction[]
}>()

const emit = defineEmits<(e: 'show-proposal') => void>()

const view = computed(() => proposalCardView(props.actions))

const countLabel = computed(() => {
  const pending = view.value.pendingCount
  if (pending === 0) {
    return trans('Decided')
  }
  return pending === 1 ? trans('1 suggestion') : trans('%s suggestions', String(pending))
})

const noteLabel = computed(() => view.value.pendingCount > 0
  ? trans('%s of %s pending. Accept or reject each change in the diff below.', String(view.value.pendingCount), String(view.value.totalCount))
  : trans('Every change of this proposal has been decided.'))
</script>

<style lang="less">
body {
  .proposal-action-card {
    display: flex;
    flex-direction: column;
    gap: 6px;

    .proposal-count.pending {
      border-color: var(--proposal-pending);
      color: var(--proposal-pending);
    }

    .proposal-actions {
      display: flex;
      gap: 6px;

      .annotation-button {
        flex: 1 1 auto;
      }
    }

    .proposal-note {
      margin: 0;
    }
  }
}
</style>
