<template>
  <span class="task-progress" v-bind:class="{ compact: props.compact }">
    <LoadingSpinner
      v-bind:spinner-size="props.compact ? 14 : 18"
      spinner-color="var(--system-accent-color, #2388ff)"
      aria-hidden="true"
    />
    <progress v-bind:value="props.percentage" max="1" v-bind:aria-label="props.label"></progress>
    <span v-if="props.percentage !== undefined" class="percentage">
      {{ Math.round(props.percentage * 100) }}%
    </span>
  </span>
</template>

<script setup lang="ts">
import LoadingSpinner from "./LoadingSpinner.vue";

const props = defineProps<{
  label: string;
  percentage?: number;
  compact?: boolean;
}>();
</script>

<style lang="css" scoped>
.task-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}

progress {
  width: 100%;
  min-width: 0;
  height: 8px;
  accent-color: var(--system-accent-color, #2388ff);
}

.percentage {
  min-width: 3ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.compact {
  width: auto;
}

.compact progress {
  width: 52px;
  height: 6px;
}
</style>
