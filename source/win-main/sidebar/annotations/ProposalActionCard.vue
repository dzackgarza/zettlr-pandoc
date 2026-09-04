<template>
  <div class="proposal-action-card" v-bind:class="{ pending: pendingCount > 0 }">
    <span class="proposal-summary">{{ summaryLabel }}</span>
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
 *                  count plus an affordance. This card renders only the
 *                  count; "Show proposal" itself is the panel's terminal
 *                  action-row control (S8), not a button inside this card,
 *                  so there is exactly one way to open a proposal. The
 *                  proposal is never applied from here as an inline edit —
 *                  the owner adjudicates it in the review surface.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { computed } from 'vue'

const props = defineProps<{
  pendingCount: number
  totalCount: number
}>()

const summaryLabel = computed(() => {
  if (props.pendingCount > 0) {
    return trans('%s proposal pending', String(props.pendingCount))
  }
  return trans('%s proposal linked', String(props.totalCount))
})
</script>

<style lang="less">
body {
  .proposal-action-card {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    border-radius: 6px;
    background-color: rgba(0, 0, 0, 0.05);
    font-size: 12px;
    margin: 8px 0;

    &.pending {
      background-color: rgba(210, 150, 30, 0.15);
      font-weight: 600;
    }
  }
}
</style>
