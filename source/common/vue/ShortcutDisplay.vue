<template>
  <div
    v-bind:class="{
      'shortcut-wrapper': true,
      'muted': props.display === 'muted'
    }"
  >
    <kbd
      v-for="label in labels"
      v-bind:key="label"
    >{{ label }}</kbd>
  </div>
</template>

<script setup lang="ts">
import type { ExplodedShortcut } from "@common/util/shortcuts";
import { computed } from "vue";

const props = defineProps<{
  shortcut: ExplodedShortcut;
  display: "muted" | "full";
}>();

/** The label of a key whose name does not show it well. */
const KEY_SYMBOLS: Readonly<Record<string, string>> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
};

/**
 * The modifiers in the order of the platform, then the key. macOS: Control,
 * Option, Shift, Command (Apple Human Interface Guidelines, "Keyboards").
 * Elsewhere: Ctrl, Alt, Shift, as the accelerators of the menu show them.
 */
const labels = computed((): string[] => {
  const { altKey, ctrlKey, modKey, shiftKey, key } = props.shortcut;
  const isMac = process.platform === "darwin";
  const modifiers = isMac
    ? [ctrlKey && "⌃", altKey && "⌥", shiftKey && "⇧", modKey && "⌘"]
    : [(ctrlKey || modKey) && "Ctrl", altKey && "Alt", shiftKey && "⇧"];
  const keyLabel = key === "" ? false : (KEY_SYMBOLS[key.toLowerCase()] ?? key);
  return [...modifiers, keyLabel].filter((label): label is string => label !== false);
});
</script>

<style lang="css" scoped>
div.shortcut-wrapper {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;

  kbd {
    font-family: inherit;
    text-transform: uppercase;
    font-size: 10px;
    border: 1px solid #666;
    color: #666;
    background-color: #fffff8;
    border-radius: 4px;
    border-bottom-width: 2px;
    border-right-width: 2px;
    padding: 2px 4px;
  }

  &.muted kbd {
    border-color: rgb(180, 180, 180);
    color: rgb(180, 180, 180);
  }
}

body.dark div.shortcut-wrapper {
  kbd {
    border-color: white;
    color: white;
    background-color: #3d3d3d;
  }

  &.muted kbd {
    border-color: rgb(180, 180, 180);
    color: rgb(180, 180, 180);
    background-color: rgb(114, 114, 104);
  }
}
</style>
