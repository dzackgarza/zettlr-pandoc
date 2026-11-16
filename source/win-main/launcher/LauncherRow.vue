<template>
  <ComboboxItem
    v-bind:value="props.value"
    v-bind:text-value="props.label"
    v-bind:disabled="props.disabled"
    class="chrome-row launcher-row"
    v-bind:class="{ 'launcher-row-with-facts': props.facts.length > 0 }"
    data-launcher-row
    v-on:select.prevent="emit('run')"
  >
    <span
      v-if="props.breadcrumb.length > 0"
      class="chrome-row-detail"
    >{{ props.breadcrumb.join(' › ') }} ›</span>
    <span class="chrome-row-label">
      <slot>{{ props.label }}</slot>
    </span>
    <span
      v-if="props.checked === true"
      class="chrome-row-trailing launcher-row-checked"
      aria-hidden="true"
    >✓</span>
    <ShortcutDisplay
      v-if="shortcut !== undefined"
      class="chrome-row-trailing"
      v-bind:shortcut="shortcut"
      display="muted"
    ></ShortcutDisplay>
    <span
      v-if="props.facts.length > 0"
      class="chrome-row-detail launcher-row-facts"
      data-launcher-row-facts
    >{{ props.facts.join(' · ') }}</span>
  </ComboboxItem>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LauncherRow
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One row of the command launcher's list: the shared
 *                  chrome row rendered as a reka-ui combobox item, so the
 *                  keyboard navigation, highlighting and selection belong to
 *                  the combobox. Every launcher view renders its rows
 *                  through this component.
 *
 * END HEADER
 */

import { explodeAccelerator } from "@common/util/shortcuts";
import ShortcutDisplay from "@common/vue/ShortcutDisplay.vue";
import { ComboboxItem } from "reka-ui";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** The row's stable identity within its list. */
    value: string;
    label: string;
    breadcrumb?: readonly string[];
    /**
     * Facts about what the row runs, on a line of their own below the
     * label: an export item shows its filters, its template and its stages.
     */
    facts?: readonly string[];
    /** An Electron accelerator, rendered as a shortcut chip. */
    accelerator?: string;
    disabled?: boolean;
    checked?: boolean;
  }>(),
  {
    breadcrumb: () => [],
    facts: () => [],
    accelerator: undefined,
    disabled: false,
    checked: undefined,
  },
);

const emit = defineEmits<(e: "run") => void>();

const shortcut = computed(() =>
  props.accelerator === undefined ? undefined : explodeAccelerator(props.accelerator),
);
</script>

<style lang="less">
// A row with facts has two lines: the label, and below it the facts in
// full. The facts wrap, so no fact is cut off.
.launcher-row.launcher-row-with-facts {
  flex-wrap: wrap;
  padding-top: 4px;
  padding-bottom: 4px;

  .launcher-row-facts {
    flex: 0 0 100%;
    margin-right: 0;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }
}
</style>
