<template>
  <TooltipProvider v-bind:delay-duration="400">
    <ToggleGroupRoot
      v-bind:id="props.barId"
      class="activity-bar"
      v-bind:data-activity-bar="props.side"
      type="single"
      orientation="vertical"
      v-bind:model-value="props.pressed"
      v-bind:aria-label="props.label"
      v-on:update:model-value="onPress"
    >
      <TooltipRoot
        v-for="item in props.items"
        v-bind:key="item.id"
      >
        <TooltipTrigger as-child>
          <ToggleGroupItem
            class="activity-bar-item"
            v-bind:value="item.id"
            v-bind:aria-label="item.label()"
            v-bind:data-activity="item.id"
          >
            <cds-icon
              v-bind:shape="item.icon"
              role="presentation"
            ></cds-icon>
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            class="activity-bar-tooltip"
            v-bind:side="props.side === 'left' ? 'right' : 'left'"
            v-bind:side-offset="6"
          >
            {{ item.label() }}
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
 * Description:     A thin column of icons at one edge of the window (D9):
 *                  one per view the pane on that edge can show, with a
 *                  tooltip. Pressing an icon opens the pane on that view or
 *                  swaps the view; pressing the pressed icon closes the
 *                  pane. Both of the window's panes are shown and hidden
 *                  this way — the sidebar's drawer from the left edge, the
 *                  annotation panel from the right.
 *
 *                  Nothing is held here: the pressed icon is given, and a
 *                  press is reported. The window decides what either means,
 *                  and reka-ui's toggle group owns the roving focus and the
 *                  deselect-on-second-press gesture.
 *
 * END HEADER
 */

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
import type { ActivityBarItem } from './sidebar-views'

const props = defineProps<{
  /** This bar's element id: a window carries one per edge. */
  barId: string
  /** The edge it sits on, which decides its border and its tooltips' side. */
  side: 'left' | 'right'
  items: readonly ActivityBarItem[]
  /** The pressed item's id, or '' while the pane is closed. */
  pressed: string
  label: string
}>()

/** Reports the pressed item, or '' when the pressed one was pressed again. */
const emit = defineEmits<(e: 'press', id: string) => void>()

function onPress (value: AcceptableValue): void {
  emit('press', typeof value === 'string' ? value : '')
}
</script>

<style lang="less">
body {
  .activity-bar {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    width: 44px;
    height: 100%;
    padding-top: 4px;
    box-sizing: border-box;
    background-color: var(--chrome-surface);

    &[data-activity-bar="left"] { border-right: 1px solid var(--chrome-border); }
    &[data-activity-bar="right"] { border-left: 1px solid var(--chrome-border); }
  }

  // Outranks the platform button rules, which box every button.
  .activity-bar button.activity-bar-item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin: 0;
    padding: 0;
    border: none;
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

    &:focus-visible {
      outline: 1px solid var(--chrome-row-accent);
      outline-offset: -1px;
    }
  }

  // The accent marks the pressed icon on the edge the bar sits at.
  .activity-bar[data-activity-bar="left"] button.activity-bar-item {
    border-left: 2px solid transparent;

    &[aria-pressed="true"] {
      color: var(--chrome-text);
      border-left-color: var(--chrome-row-accent);
    }
  }

  .activity-bar[data-activity-bar="right"] button.activity-bar-item {
    border-right: 2px solid transparent;

    &[aria-pressed="true"] {
      color: var(--chrome-text);
      border-right-color: var(--chrome-row-accent);
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
