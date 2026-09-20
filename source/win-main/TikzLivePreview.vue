<template>
  <aside
    class="tikz-live-preview"
    :class="{ fullscreen }"
    aria-label="TikZ preview"
    :data-tikz-language="props.target.language"
  >
    <header class="tikz-live-preview-header">
      <span class="tikz-live-preview-label">Preview:</span>
      <div
        class="tikz-live-preview-modes"
        role="group"
        aria-label="Preview mode"
      >
        <button
          v-for="provider in providers"
          :key="provider.id"
          type="button"
          :class="{ active: displayMode === provider.id }"
          :aria-pressed="displayMode === provider.id"
          :disabled="!provider.supports(props.target)"
          :title="provider.supports(props.target) ? '' : provider.unavailableTitle(props.target)"
          @click="selectProvider(provider.id)"
        >
          {{ provider.label }}
        </button>
      </div>

      <span class="tikz-live-preview-status">{{ activeStatus }}</span>
      <LoadingSpinner
        v-if="activeBusy"
        class="tikz-live-preview-spinner"
        :spinner-size="14"
        aria-hidden="true"
      />
      <button
        v-if="activeProvider.refreshable"
        type="button"
        class="tikz-live-preview-action tikz-live-preview-refresh"
        title="Rebuild TikZ preview"
        aria-label="Rebuild TikZ preview"
        @click="forceRefresh"
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
      <component
        :is="activeProvider.component"
        ref="previewHandle"
        :key="`${activeProvider.id}\0${targetIdentity(props.target)}`"
        class="tikz-live-preview-provider"
        :target="props.target"
        :editor-view="props.editorView"
        :fullscreen="fullscreen"
        @exit-fullscreen="fullscreen = false"
        @status="activeStatus = $event"
        @busy="activeBusy = $event"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Provider-driven TikZ preview sidecar
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     One RHS surface for TikZ authoring whose preview/editor
 *                  modes are registered providers. The shell owns only mode
 *                  selection, status, refresh dispatch and fullscreen geometry;
 *                  each provider owns its rendering and source synchronization.
 *
 * END HEADER
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import {
  type TikzLivePreviewTarget
} from '@common/modules/markdown-editor/tikz-live-preview'
import {
  defaultTikzPreviewMode,
  resolvedTikzPreviewMode,
  type TikzPreviewModeId
} from '@common/modules/markdown-editor/tikz-preview-modes'
import LoadingSpinner from 'source/common/vue/LoadingSpinner.vue'
import {
  TIKZ_PREVIEW_PROVIDERS,
  type TikzPreviewProvider
} from './tikz-preview-providers'

const props = defineProps<{
  target: TikzLivePreviewTarget
  editorView: EditorView
}>()

const fullscreen = ref(false)
const requestedMode = ref<TikzPreviewModeId>(defaultTikzPreviewMode(props.target))
const activeStatus = ref('')
const activeBusy = ref(false)
const previewHandle = ref<{ refresh?: () => void }|null>(null)
const providers: readonly TikzPreviewProvider[] = TIKZ_PREVIEW_PROVIDERS
const displayMode = computed(() => resolvedTikzPreviewMode(requestedMode.value, props.target))
const activeProvider = computed(() => {
  const provider = providers.find(candidate => candidate.id === displayMode.value)
  if (provider === undefined) {
    throw new Error(`No TikZ preview provider registered for mode ${displayMode.value}`)
  }
  return provider
})

function targetIdentity (target: TikzLivePreviewTarget): string {
  return `${target.docPath}\0${target.kind}\0${target.language}\0${target.from}`
}

watch(
  () => targetIdentity(props.target),
  () => {
    requestedMode.value = defaultTikzPreviewMode(props.target)
    fullscreen.value = false
  }
)

watch(
  displayMode,
  () => {
    activeStatus.value = ''
    activeBusy.value = false
  }
)

function selectProvider (mode: TikzPreviewModeId): void {
  const provider = providers.find(candidate => candidate.id === mode)
  if (provider?.supports(props.target) === true) {
    requestedMode.value = mode
  }
}

function forceRefresh (): void {
  previewHandle.value?.refresh?.()
}

function onWindowKeydown (event: KeyboardEvent): void {
  if (fullscreen.value && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    fullscreen.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
})
</script>

<style scoped lang="less">
.tikz-live-preview {
  flex: 0 0 42%;
  min-width: 260px;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #d5d5d5;
  background: #f7f7f7;
  color: inherit;

  &.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 5000;
    width: auto;
    height: auto;
    min-width: 0;
    border-left: 0;
  }
}

.tikz-live-preview-header {
  flex: 0 0 auto;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid #dedede;
  font-size: 0.8rem;
  user-select: none;
}

.tikz-live-preview-label {
  font-weight: 600;
}

.tikz-live-preview-modes {
  display: inline-flex;
  padding: 2px;
  border-radius: 5px;
  background: color-mix(in srgb, currentColor 7%, transparent);

  button {
    border: 0;
    border-radius: 4px;
    padding: 3px 9px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;

    &.active {
      background: color-mix(in srgb, currentColor 12%, transparent);
      font-weight: 600;
    }

    &:disabled {
      opacity: 0.34;
      cursor: not-allowed;
    }
  }
}

.tikz-live-preview-status {
  margin-left: auto;
  opacity: 0.6;
}

.tikz-live-preview-spinner {
  flex: 0 0 auto;
  opacity: 0.72;
}

.tikz-live-preview-action {
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  padding: 3px 5px;
  line-height: 1;
  font-size: 1rem;
  cursor: pointer;

  &:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
}

.tikz-live-preview-content {
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

:global(body.dark .tikz-live-preview) {
  border-left-color: #505050;
  background: #252526;
}

:global(body.dark .tikz-live-preview-header) {
  border-bottom-color: #444;
}

</style>
