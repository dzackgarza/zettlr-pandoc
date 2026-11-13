<template>
  <aside
    class="tikz-live-preview"
    :class="{ fullscreen, dark: props.theme === 'dark' }"
    aria-label="TikZ preview"
    :data-tikz-language="props.target.language"
  >
    <header class="tikz-live-preview-header">
      <slot name="actions" />
      <span class="tikz-live-preview-status">{{ status }}</span>
      <span
        v-if="busy"
        class="tikz-live-preview-spinner"
        aria-hidden="true"
      />
      <button
        type="button"
        class="tikz-live-preview-action tikz-live-preview-refresh"
        title="Rebuild TikZ preview"
        aria-label="Rebuild TikZ preview"
        @click="preview?.refresh()"
      >
        <span aria-hidden="true">↻</span>
      </button>
      <button
        type="button"
        class="tikz-live-preview-action tikz-live-preview-expand"
        :title="fullscreen ? 'Exit fullscreen preview (Esc)' : 'Open fullscreen preview'"
        :aria-label="fullscreen ? 'Exit fullscreen preview' : 'Open fullscreen preview'"
        @click="fullscreen = !fullscreen"
      >
        <span aria-hidden="true">{{ fullscreen ? '↙' : '⤢' }}</span>
      </button>
    </header>

    <div class="tikz-live-preview-content">
      <TikzCompilerPreview
        ref="preview"
        class="tikz-live-preview-provider"
        :target="props.target"
        :host="props.host"
        :theme="props.theme"
        :fullscreen="fullscreen"
        @status="status = $event"
        @busy="busy = $event"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ preview pane
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     The pane around the compiled preview of one figure: the
 *                  render status, the rebuild control and the fullscreen
 *                  geometry. The `actions` slot holds the controls of the
 *                  application that shows the pane.
 *
 * END HEADER
 */

import { onBeforeUnmount, onMounted, ref } from "vue";
import type { TikzPreviewHost, TikzPreviewTheme } from "../host";
import type { TikzLivePreviewTarget } from "../live-preview";
import TikzCompilerPreview from "./TikzCompilerPreview.vue";

const props = defineProps<{
  target: TikzLivePreviewTarget;
  host: TikzPreviewHost;
  theme: TikzPreviewTheme;
}>();

const fullscreen = ref(false);
const status = ref("");
const busy = ref(false);
const preview = ref<{ refresh: () => void } | null>(null);

function onWindowKeydown(event: KeyboardEvent): void {
  if (fullscreen.value && event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    fullscreen.value = false;
  }
}

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown, true);
});
</script>

<style scoped lang="less">
.tikz-live-preview {
  --surface: #eef0ea;
  --text: #1c2430;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fbfaf6;
  color: var(--text);

  &.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 5000;
    width: auto;
    height: auto;
    min-width: 0;
  }
}

.tikz-live-preview-header {
  flex: 0 0 auto;
  min-height: 52px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--text) 15%, transparent);
  background: var(--surface);
  font-size: 0.9rem;
  user-select: none;
}

.tikz-live-preview-status {
  margin-left: auto;
  opacity: 0.6;
}

.tikz-live-preview-spinner {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  opacity: 0.72;
  animation: tikz-live-preview-spin 0.8s linear infinite;
}

@keyframes tikz-live-preview-spin {
  to { transform: rotate(360deg); }
}

.tikz-live-preview-action {
  border: 0;
  min-width: 44px;
  min-height: 44px;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  padding: 3px 5px;
  line-height: 1;
  font-size: 1rem;
  cursor: pointer;

  &:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
}

.tikz-live-preview-content {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tikz-live-preview-provider {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  overflow: hidden;
}

.tikz-live-preview.dark {
  --surface: #313b45;
  --text: #f3f2ed;
  background: #1d242b;
}
</style>
