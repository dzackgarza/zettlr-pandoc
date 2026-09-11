<template>
  <div class="annotation-header">
    <div class="annotation-header-title-row">
      <cds-icon
        shape="chat-bubble"
        role="presentation"
      ></cds-icon>
      <span class="annotation-header-title">{{ trans('Annotations') }}</span>
      <span class="annotation-header-count annotation-muted">
        <span class="annotation-open-count">({{ openCount }})</span>
      </span>
      <ShortcutDisplay
        v-if="shortcut !== undefined"
        class="annotation-header-shortcut"
        v-bind:shortcut="shortcut"
        display="muted"
      ></ShortcutDisplay>
      <button
        type="button"
        class="annotation-icon-button annotation-header-close"
        v-bind:title="closeLabel"
        v-bind:aria-label="closeLabel"
        v-on:click="emit('close')"
      >
        <cds-icon
          shape="times"
          role="presentation"
        ></cds-icon>
      </button>
    </div>
    <div class="annotation-view-row">
      <DropdownMenuRoot>
        <DropdownMenuTrigger class="annotation-view-selector">
          <cds-icon
            shape="view-list"
            role="presentation"
          ></cds-icon>
          <span>{{ viewLabel }}</span>
          <cds-icon
            shape="angle"
            direction="down"
            role="presentation"
          ></cds-icon>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            class="annotation-view-menu"
            align="start"
            v-bind:side-offset="4"
          >
            <DropdownMenuRadioGroup
              v-bind:model-value="props.view"
              v-on:update:model-value="onSelectView"
            >
              <DropdownMenuRadioItem
                class="annotation-view-option"
                value="open"
              >
                {{ trans('Open') }}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                class="annotation-view-option"
                value="resolved"
              >
                {{ trans('Resolved') }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      <button
        type="button"
        class="annotation-icon-button annotations-filter-toggle"
        v-bind:class="{ active: filterOpen }"
        v-bind:title="filterLabel"
        v-bind:aria-label="filterLabel"
        v-bind:aria-pressed="filterOpen"
        v-on:click="filterOpen = !filterOpen"
      >
        <cds-icon
          shape="filter"
          role="presentation"
        ></cds-icon>
      </button>
    </div>
    <input
      v-if="filterOpen"
      v-bind:value="query"
      type="search"
      class="annotations-filter-input"
      v-bind:placeholder="filterLabel"
      v-on:input="emit('update:query', ($event.target as HTMLInputElement).value)"
    >
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationHeader
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The panel's header: one body-size title row (glyph,
 *                  "Annotations", the open count (S10: open only), the
 *                  panel toggle's shortcut chip read from the application
 *                  menu, close) and the view row (the Open / Resolved
 *                  selector over the store's showResolved, the filter
 *                  toggle). The count prop is the single source both this
 *                  header and the list read.
 *
 * END HEADER
 */

import { computed, onBeforeMount, onBeforeUnmount, ref } from 'vue'
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  type AcceptableValue
} from 'reka-ui'
import { trans } from '@common/i18n-renderer'
import ShortcutDisplay from '@common/vue/ShortcutDisplay.vue'
import { explodeAccelerator } from '@common/util/shortcuts'
import { menuProviderMessageSchema } from '@dts/common/serialized-menu'
import { allMenuLeafRows } from '../../launcher/launcher-rows'

export type AnnotationListView = 'open' | 'resolved'

const props = defineProps<{
  openCount: number
  query: string
  view: AnnotationListView
}>()

const emit = defineEmits<{
  (e: 'update:query', value: string): void
  (e: 'set-view', view: AnnotationListView): void
  (e: 'close'): void
}>()

const ipcRenderer = window.ipc

const closeLabel = trans('Close')
const filterLabel = trans('Filter annotations')

const filterOpen = ref(false)

const viewLabel = computed(() => props.view === 'resolved' ? trans('Resolved') : trans('Open'))

function onSelectView (value: AcceptableValue): void {
  emit('set-view', value === 'resolved' ? 'resolved' : 'open')
}

// The panel toggle's shortcut, from the one definition of that command: the
// application menu item the menu provider serialises.
const TOGGLE_ITEM_ID = 'menu.toggle_annotation_panel'
const accelerator = ref<string | undefined>(undefined)
let stopListening: () => void = () => {}

onBeforeMount(() => {
  stopListening = ipcRenderer.on('menu-provider', (_event, payload: unknown) => {
    const message = menuProviderMessageSchema.parse(payload)
    if (message.command === 'application-menu') {
      accelerator.value = allMenuLeafRows(message.payload).find(row => row.id === TOGGLE_ITEM_ID)?.accelerator
    }
  })
  ipcRenderer.send('menu-provider', { command: 'get-application-menu' })
})

onBeforeUnmount(() => { stopListening() })

const shortcut = computed(() => accelerator.value === undefined ? undefined : explodeAccelerator(accelerator.value))
</script>

<style lang="less">
body {
  .annotation-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: var(--annotation-gap);
    border-bottom: 1px solid var(--annotation-border);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .annotation-header-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;

    > cds-icon {
      width: 16px;
      height: 16px;
      color: var(--annotation-text-muted);
    }

    .annotation-header-title {
      font-weight: 600;
    }

    .annotation-header-count {
      flex: 1 1 auto;
    }

    .annotation-header-shortcut {
      color: var(--annotation-text-muted);
      font-size: var(--annotation-small-font-size);
    }
  }

  // Outranks ShortcutDisplay's own scoped rule, which wraps its key caps.
  .annotations-tab .annotation-header-title-row .annotation-header-shortcut {
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
}

// A narrow pane has no room for the shortcut chip beside the title; the
// count and close stay.
@container annotations-panel (max-width: 320px) {
  body .annotations-tab .annotation-header-shortcut {
    display: none;
  }
}

body {
  .annotation-view-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  button.annotation-view-selector {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 3px 8px;
    border: 1px solid var(--annotation-border);
    border-radius: 6px;
    background: transparent;
    color: var(--annotation-text);
    font: inherit;
    font-size: var(--annotation-small-font-size);
    cursor: pointer;

    &:hover {
      background-color: var(--annotation-surface-muted);
    }

    cds-icon {
      width: 12px;
      height: 12px;
    }
  }

  .annotations-filter-input {
    box-sizing: border-box;
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--annotation-border);
    border-radius: 6px;
    background-color: var(--annotation-surface);
    color: var(--annotation-text);
    font: inherit;
    font-size: var(--annotation-font-size);
  }
}

// The view menu renders through a portal, outside the panel.
body .annotation-view-menu {
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--annotation-border);
  border-radius: 8px;
  background-color: var(--annotation-surface);
  color: var(--annotation-text);
  font-size: var(--annotation-font-size);
  box-shadow: var(--chrome-elevation, none);

  .annotation-view-option {
    padding: 5px 8px;
    border-radius: 4px;
    cursor: pointer;
    outline: none;

    &[data-highlighted] {
      background-color: var(--annotation-surface-muted);
    }

    &[data-state="checked"] {
      color: var(--annotation-accent);
    }
  }
}
</style>
