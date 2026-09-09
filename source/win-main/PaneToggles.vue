<template>
  <div
    class="pane-toggles"
    role="group"
    v-bind:aria-label="groupLabel"
  >
    <button
      type="button"
      class="pane-toggle"
      data-pane-toggle="navigation-sidebar"
      v-bind:title="sidebarLabel"
      v-bind:aria-label="sidebarLabel"
      v-bind:aria-pressed="sidebarVisible"
      v-on:click="configStore.setConfigValue('window.fileManagerVisible', !sidebarVisible)"
    >
      <cds-icon
        shape="tree-view"
        role="presentation"
      ></cds-icon>
    </button>
    <button
      type="button"
      class="pane-toggle"
      data-pane-toggle="annotation-panel"
      v-bind:title="panelLabel"
      v-bind:aria-label="panelLabel"
      v-bind:aria-pressed="panelVisible"
      v-on:click="configStore.setConfigValue('window.sidebarVisible', !panelVisible)"
    >
      <cds-icon
        shape="chat-bubble"
        role="presentation"
      ></cds-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PaneToggles
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The two icons at the right end of the window's document
 *                  tab row: the sidebar toggle and the annotation panel
 *                  toggle. Each flips the pane's visibility in the config,
 *                  the same value the View menu items and their shortcuts
 *                  flip.
 *
 * END HEADER
 */

import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'
import { useConfigStore } from 'source/pinia'

const configStore = useConfigStore()

const groupLabel = trans('Panes')
const sidebarLabel = trans('Toggle Sidebar')
const panelLabel = trans('Toggle Annotation Panel')

const sidebarVisible = computed(() => configStore.config.window.fileManagerVisible)
const panelVisible = computed(() => configStore.config.window.sidebarVisible)
</script>

<style lang="less">
// `body … button.…` outweighs the platform button rules in generic.css.
body .pane-toggles {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 0 6px;
  // Stays at the row's right end while the tabs scroll underneath.
  position: sticky;
  right: 0;
  background-color: inherit;

  button.pane-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--chrome-text-muted);
    cursor: pointer;

    &:hover {
      background-color: var(--chrome-row-hover-bg);
    }

    &[aria-pressed="true"] {
      color: var(--chrome-text);
    }

    cds-icon {
      width: 16px;
      height: 16px;
    }
  }
}
</style>
