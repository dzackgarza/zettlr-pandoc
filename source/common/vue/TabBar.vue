<template>
  <div class="system-tablist" role="tablist">
    <button
      v-for="tab, idx in props.tabs"
      v-bind:key="idx"
      role="tab"
      v-bind:aria-label="tab.label"
      v-bind:aria-selected="props.currentTab === tab.id"
      v-bind:aria-controls="tab.target"
      v-bind:data-target="tab.target"
      v-bind:class="{
        'system-tab': true,
        active: props.currentTab === tab.id
      }"
      v-bind:title="tab.label"
      v-on:click="emit('tab', tab.id)"
    >
      <!-- Display either an icon, or the title -->
      <cds-icon
        v-if="tab.icon !== undefined"
        v-bind:shape="tab.icon"
        role="presentation"
      ></cds-icon>
      <template v-else>
        {{ tab.label }}
      </template>
      <span
        v-if="tab.badge !== undefined && tab.badge > 0"
        class="system-tab-badge"
      >{{ tab.badge }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tabs component
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component resembles a "regular" tabbar (neither the
 *                  window-wide one nor the somewhat bigger document tabs).
 *
 * END HEADER
 */

import type { TabbarControl } from '@dts/common/tabbar'

export type { TabbarControl }

const props = defineProps<{
  tabs: TabbarControl[]
  currentTab: string
}>()

const emit = defineEmits<(e: 'tab', value: string) => void>()
</script>

<style lang="less">
body .system-tablist {
  display: flex;
  justify-content: space-evenly;

  .system-tab {
    flex-grow: 1;
    text-align: center;
    position: relative;
  }

  .system-tab-badge {
    display: inline-block;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    margin-left: 4px;
    border-radius: 999px;
    background-color: var(--system-accent-color, #4c8dca);
    color: white;
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    vertical-align: middle;
  }
}

body.darwin {
  .system-tablist {
    justify-content: space-around;
    padding: 10px 20px 0px 20px;

    .system-tab {
      &.active { background-color: rgb(230, 230, 230); }

      &:not(:first-child) {
        border-top-left-radius: 0px;
        border-bottom-left-radius: 0px;
        border-left: 0px; // We only want 1px border between the buttons
      }

      &:not(:last-child) {
        border-top-right-radius: 0px;
        border-bottom-right-radius: 0px;
      }
    }
  }

  &.dark {
    .system-tablist .system-tab {
      &.active { background-color: rgb(120, 120, 120); }

      &:not(:last-child) {
        // We need a border here
        border-right: 1px solid rgb(120, 120, 120);
      }
    }
  }
}

body.win32 {
  .system-tablist .system-tab.active {
    background-color: rgb(230, 230, 230);
  }

  &.dark .system-tablist .system-tab.active {
    background-color: rgb(120, 120, 120);
  }
}
</style>
