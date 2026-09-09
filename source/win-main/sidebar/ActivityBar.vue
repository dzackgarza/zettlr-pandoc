<template>
  <TooltipProvider v-bind:delay-duration="400">
    <ToggleGroupRoot
      id="activity-bar"
      type="single"
      orientation="vertical"
      v-bind:model-value="pressed"
      v-bind:aria-label="barLabel"
      v-on:update:model-value="onPress"
    >
      <TooltipRoot
        v-for="view in SIDEBAR_VIEWS"
        v-bind:key="view.id"
      >
        <TooltipTrigger as-child>
          <ToggleGroupItem
            class="activity-bar-item"
            v-bind:value="view.id"
            v-bind:aria-label="view.label()"
            v-bind:data-activity="view.id"
          >
            <cds-icon
              v-bind:shape="view.icon"
              role="presentation"
            ></cds-icon>
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            class="activity-bar-tooltip"
            side="right"
            v-bind:side-offset="6"
          >
            {{ view.label() }}
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>
    </ToggleGroupRoot>
  </TooltipProvider>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ActivityBar
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The thin column of icons at the window's left edge (D9):
 *                  one per sidebar view, with a tooltip. Pressing an icon
 *                  opens the drawer on that view or swaps the view; pressing
 *                  the pressed icon closes the drawer. The pressed state is
 *                  derived from config — the drawer's visibility and the
 *                  shown view — never held here; reka-ui's toggle group owns
 *                  the roving focus and the deselect-on-second-press gesture.
 *
 * END HEADER
 */

import { computed } from 'vue'
import {
  ToggleGroupItem,
  ToggleGroupRoot,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  type AcceptableValue
} from 'reka-ui'
import { trans } from '@common/i18n-renderer'
import { isSidebarViewId } from '@dts/common/sidebar-views'
import { useConfigStore } from 'source/pinia'
import { SIDEBAR_VIEWS } from './sidebar-views'

const configStore = useConfigStore()
const barLabel = trans('Sidebar views')

/** The pressed icon: the shown view while the drawer is open, none while closed. */
const pressed = computed<string>(() => configStore.config.window.fileManagerVisible ? configStore.config.ui.sidebarView : '')

function onPress (value: AcceptableValue): void {
  if (typeof value === 'string' && isSidebarViewId(value)) {
    configStore.setConfigValue('ui.sidebarView', value)
    configStore.setConfigValue('window.fileManagerVisible', true)
    return
  }
  configStore.setConfigValue('window.fileManagerVisible', false)
}
</script>

<style lang="less">
body {
  #activity-bar {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    width: 44px;
    height: 100%;
    padding-top: 4px;
    box-sizing: border-box;
    background-color: var(--chrome-surface);
    border-right: 1px solid var(--chrome-border);
  }

  // Outranks the platform button rules, which box every button.
  #activity-bar button.activity-bar-item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin: 0;
    padding: 0;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
    color: var(--chrome-text-muted);
    cursor: pointer;

    cds-icon {
      width: 22px;
      height: 22px;
    }

    &:hover {
      color: var(--chrome-text);
    }

    &[aria-pressed="true"] {
      color: var(--chrome-text);
      border-left-color: var(--chrome-row-accent);
    }

    &:focus-visible {
      outline: 1px solid var(--chrome-row-accent);
      outline-offset: -1px;
    }
  }

  .activity-bar-tooltip {
    padding: 3px 8px;
    border: 1px solid var(--chrome-border);
    border-radius: 4px;
    background-color: var(--chrome-surface);
    color: var(--chrome-text);
    font-size: var(--chrome-font-size);
    box-shadow: var(--chrome-elevation);
  }
}
</style>
