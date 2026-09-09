<template>
  <ComboboxItem
    v-bind:value="props.value"
    v-bind:text-value="props.label"
    v-bind:disabled="props.disabled"
    class="chrome-row launcher-row"
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

import { ComboboxItem } from 'reka-ui'
import { computed } from 'vue'
import ShortcutDisplay from '@common/vue/ShortcutDisplay.vue'
import { explodeAccelerator } from '@common/util/shortcuts'

const props = withDefaults(defineProps<{
  /** The row's stable identity within its list. */
  value: string
  label: string
  breadcrumb?: readonly string[]
  /** An Electron accelerator, rendered as a shortcut chip. */
  accelerator?: string
  disabled?: boolean
  checked?: boolean
}>(), {
  breadcrumb: () => [],
  accelerator: undefined,
  disabled: false,
  checked: undefined
})

const emit = defineEmits<(e: 'run') => void>()

const shortcut = computed(() => props.accelerator === undefined ? undefined : explodeAccelerator(props.accelerator))
</script>
