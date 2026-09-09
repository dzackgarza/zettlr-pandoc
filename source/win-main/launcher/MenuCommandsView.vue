<template>
  <ComboboxRoot
    ref="combobox"
    class="launcher-view"
    v-bind:open="true"
    v-bind:ignore-filter="true"
    v-bind:reset-search-term-on-blur="false"
    v-bind:reset-search-term-on-select="false"
    model-value=""
  >
    <div class="launcher-query-row">
      <span
        v-if="props.breadcrumb.length > 0"
        class="launcher-breadcrumb"
      >{{ props.breadcrumb.join(' › ') }}</span>
      <ComboboxInput
        class="launcher-input"
        data-command-launcher-input
        v-bind:auto-focus="true"
        v-bind:model-value="props.query"
        v-bind:placeholder="placeholder"
        v-on:update:model-value="emit('update:query', $event)"
        v-on:keydown.backspace="onBackspace"
      ></ComboboxInput>
    </div>
    <ComboboxContent
      class="launcher-list"
      position="inline"
      v-on:escape-key-down="onEscape"
    >
      <ComboboxViewport class="launcher-viewport">
        <LauncherRow
          v-for="row in props.rows"
          v-bind:key="rowKey(row)"
          v-bind:value="rowKey(row)"
          v-bind:label="row.label"
          v-bind:breadcrumb="rowBreadcrumb(row)"
          v-bind:accelerator="row.kind === 'menu-leaf' ? row.accelerator : undefined"
          v-bind:disabled="isDisabled(row)"
          v-bind:checked="row.kind === 'menu-leaf' ? row.checked : undefined"
          v-bind:data-row-kind="row.kind"
          v-on:run="emit('run', row)"
        >
          <template v-if="row.kind === 'heading'">
            {{ row.line }}. {{ row.label }}
          </template>
        </LauncherRow>
        <ComboboxEmpty class="launcher-empty">
          {{ emptyLabel }}
        </ComboboxEmpty>
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MenuCommandsView
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The launcher's command list: one combobox over the rows
 *                  the launcher computed for the current view and query.
 *                  reka-ui owns Arrow, Home, End, Enter and the highlight;
 *                  the one key this view owns is Backspace on an empty
 *                  query, which goes up one level.
 *
 * END HEADER
 */

import { ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxRoot, ComboboxViewport } from 'reka-ui'
import { nextTick, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import LauncherRow from './LauncherRow.vue'
import { rowKey, type LauncherRow as LauncherRowModel } from './launcher-rows'

const props = defineProps<{
  rows: readonly LauncherRowModel[]
  query: string
  /** The labels of the groups above the current view, root first. */
  breadcrumb: readonly string[]
}>()

const emit = defineEmits<{
  (e: 'update:query', query: string): void
  (e: 'run', row: LauncherRowModel): void
  (e: 'back'): void
  (e: 'close'): void
}>()

const placeholder = trans('Type a command…')
const emptyLabel = trans('No matching commands')

interface ComboboxHandle {
  highlightFirstItem: () => void
}

const combobox = ref<ComboboxHandle | null>(null)

/** A menu leaf reports its own enablement; every other row is always runnable. */
function isDisabled (row: LauncherRowModel): boolean {
  return (row.kind === 'menu-leaf' || row.kind === 'menu-group') && !row.enabled
}

/**
 * A row's breadcrumb shows only the groups below the current view: a group's
 * own rows carry none, and leaves listed at the root by a query show their
 * whole path.
 */
function rowBreadcrumb (row: LauncherRowModel): readonly string[] {
  if (row.kind === 'file') {
    return row.breadcrumb
  }
  if (row.kind === 'menu-leaf' || row.kind === 'menu-group') {
    return row.breadcrumb.slice(props.breadcrumb.length)
  }
  return []
}

// Ranking replaces the list on every keystroke, so the first row must be
// highlighted again for Enter to mean "run the best match".
watch(() => props.rows, () => {
  nextTick()
    .then(() => { combobox.value?.highlightFirstItem() })
    .catch(err => console.error('[MenuCommandsView] Could not highlight the first row', err))
}, { immediate: true })

function onBackspace (): void {
  if (props.query === '') {
    emit('back')
  }
}

function onEscape (event: Event): void {
  event.preventDefault()
  emit('close')
}
</script>
