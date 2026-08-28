<template>
  <div class="export-config-summary">
    <div class="ecs-row">
      <span class="ecs-label">Filters</span>
      <span class="ecs-value">{{ filtersText }}</span>
    </div>
    <div class="ecs-row">
      <span class="ecs-label">Template</span>
      <span class="ecs-value">{{ templateText }}</span>
    </div>
    <div class="ecs-row">
      <span class="ecs-label">Pandoc data dir</span>
      <span class="ecs-value">{{ dataDir }}</span>
    </div>
    <div v-if="scriptInfo !== ''" class="ecs-row">
      <span class="ecs-label">Script</span>
      <span class="ecs-value">{{ scriptInfo }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    // The ordered, declared export filter chain (config.export.filters).
    filters: string[];
    // The profile's declared Pandoc template, or '' for Pandoc's built-in default.
    template: string;
    // The Pandoc data directory names/templates resolve from.
    dataDir: string;
    // For script formats: a "profile -> command" summary. '' when not a script.
    scriptInfo?: string;
  }>(),
  { scriptInfo: "" },
);

const filtersText = computed(() =>
  props.filters.length > 0 ? props.filters.join("  →  ") : "(none)",
);
const templateText = computed(() => (props.template !== "" ? props.template : "Pandoc default"));
</script>

<style>
.export-config-summary {
  font-size: 11px;
  line-height: 1.5;
  padding: 6px 8px;
  border-radius: 4px;
  background-color: rgba(127, 127, 127, 0.08);
}

.export-config-summary .ecs-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.export-config-summary .ecs-label {
  flex: 0 0 96px;
  color: rgba(127, 127, 127, 1);
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.04em;
}

.export-config-summary .ecs-value {
  flex: 1 1 auto;
  font-family: monospace;
  word-break: break-word;
}
</style>
