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
    <div
      v-if="!reviewFrozen && view.pendingCount > 0"
      class="proposal-actions"
    >
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
 *                  moves the editor to the first linked chunk; the proposal
 *                  is never applied from here — the owner decides each
 *                  chunk with the controls under it.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { AnnotationProposalAction } from "@dts/common/annotation-domain";
import { computed } from "vue";
import {
  type ProposalOutcome,
  proposalCardView,
} from "../sidebar/annotations/annotation-presentation";

const props = defineProps<{
  actions: readonly AnnotationProposalAction[];
  /** The review is frozen: its chunks are not in the editor to show or decide. */
  reviewFrozen: boolean;
}>();

const emit = defineEmits<(e: "show-proposal") => void>();

const view = computed(() => proposalCardView(props.actions));

const countLabel = computed(() => {
  const pending = view.value.pendingCount;
  if (pending === 0) {
    return trans("Done");
  }
  return pending === 1 ? trans("1 suggestion") : trans("%s suggestions", String(pending));
});

function outcomeLabel(outcome: ProposalOutcome, count: number): string {
  const n = String(count);
  switch (outcome) {
    case "accepted":
      return trans("%s accepted", n);
    case "rejected":
      return trans("%s rejected", n);
    case "mixed":
      return trans("%s partly accepted", n);
    case "withdrawn":
      return trans("%s withdrawn by the agent", n);
    case "cleared":
      return trans("%s cleared with the review", n);
  }
}

/** What happened to the proposals that are not pending: "1 accepted, 1 rejected." */
const outcomesLabel = computed(() =>
  view.value.outcomes.length === 0
    ? ""
    : `${view.value.outcomes.map((entry) => outcomeLabel(entry.outcome, entry.count)).join(", ")}.`,
);

const noteLabel = computed(() => {
  if (view.value.pendingCount === 0) {
    return outcomesLabel.value;
  }
  const pending = props.reviewFrozen
    ? trans(
        "The file changed on disk, so these changes are frozen. Reapply, return or discard the review in the annotations panel.",
      )
    : trans(
        "%s of %s pending. Accept or reject each change where it appears in the document.",
        String(view.value.pendingCount),
        String(view.value.totalCount),
      );
  return outcomesLabel.value === "" ? pending : `${outcomesLabel.value} ${pending}`;
});
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
