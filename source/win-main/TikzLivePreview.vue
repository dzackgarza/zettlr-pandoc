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
        aria-label="Preview renderer"
      >
        <button
          type="button"
          :class="{ active: displayMode === 'tikz' }"
          :aria-pressed="displayMode === 'tikz'"
          @click="previewMode = 'tikz'"
        >
          TikZ
        </button>
        <button
          type="button"
          :class="{ active: displayMode === 'quiver' }"
          :aria-pressed="displayMode === 'quiver'"
          :disabled="!isTikzCd"
          :title="isTikzCd ? 'Preview and edit with Quiver' : 'Quiver is available only for tikzcd diagrams'"
          @click="previewMode = 'quiver'"
        >
          Quiver
        </button>
      </div>

      <span class="tikz-live-preview-status">{{ activeStatus }}</span>
      <LoadingSpinner
        v-if="displayMode === 'tikz' && state.rendering"
        class="tikz-live-preview-spinner"
        :spinner-size="14"
        aria-hidden="true"
      />
      <button
        v-if="displayMode === 'tikz'"
        type="button"
        class="tikz-live-preview-action tikz-live-preview-refresh"
        title="Force TikZ rerender (ignore cache)"
        aria-label="Force TikZ rerender (ignore cache)"
        @click="controller.forceRender()"
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
      <TikzQuiverPreview
        v-if="displayMode === 'quiver' && isTikzCd"
        class="tikz-live-preview-quiver"
        :target="props.target"
        :editor-view="props.editorView"
        :fullscreen="fullscreen"
        @exit-fullscreen="fullscreen = false"
        @status="quiverStatus = $event"
      />

      <template v-else>
        <div
          class="tikz-live-preview-canvas"
          :class="{ stale: state.stale || state.failure !== null }"
        >
          <TikzFigureViewer
            v-if="state.lastGood !== null"
            ref="figureViewer"
            class="tikz-live-preview-figure"
            :svg-path="state.lastGood.result.svgPath"
            :show-fullscreen-button="false"
          />
          <div
            v-else-if="state.pending"
            class="tikz-live-preview-placeholder"
          >
            Rendering TikZ…
          </div>
          <div
            v-else
            class="tikz-live-preview-placeholder"
          >
            No successful render yet.
          </div>
        </div>

        <div
          v-if="state.failure !== null"
          class="tikz-live-preview-error"
          role="status"
        >
          <div class="tikz-live-preview-error-summary">
            {{ failureSummary }}
          </div>
          <details v-if="failureDetails !== ''">
            <summary>Details</summary>
            <pre>{{ failureDetails }}</pre>
          </details>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unified TikZ/Quiver preview sidecar
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     One RHS preview surface for TikZ authoring. Ordinary TikZ
 *                  uses the Viewer.js live render. tikzcd defaults to the
 *                  vendored Quiver editor and can switch to the same vanilla
 *                  TikZ renderer. The pane itself owns fullscreen promotion so
 *                  both preview modes share one toggle and one expansion path.
 *
 * END HEADER
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import { reportError } from '@common/util/error-reporting'
import {
  TikzLivePreviewController,
  type TikzLivePreviewState,
  type TikzLivePreviewTarget,
  type TikzRenderFailure
} from '@common/modules/markdown-editor/tikz-live-preview'
import type { TikzRenderRequest, TikzRenderResult } from 'source/app/util/tikz-render'
import LoadingSpinner from 'source/common/vue/LoadingSpinner.vue'
import TikzFigureViewer from './TikzFigureViewer.vue'
import TikzQuiverPreview from './TikzQuiverPreview.vue'

const props = defineProps<{
  target: TikzLivePreviewTarget
  editorView: EditorView
}>()

type PreviewMode = 'tikz'|'quiver'
interface FigureViewerHandle { fit: () => void }

async function render (request: TikzRenderRequest): Promise<TikzRenderResult> {
  try {
    return await window.ipc.invoke('application', {
      command: 'tikz-render',
      payload: request
    })
  } catch (error) {
    reportError('TikZ live preview IPC failed', error)
    return {
      ok: false,
      kind: 'pandoc-error',
      log: error instanceof Error ? error.message : String(error)
    }
  }
}

const EMPTY_STATE: TikzLivePreviewState = {
  target: null,
  lastGood: null,
  failure: null,
  pending: false,
  rendering: false,
  stale: false
}

const state = shallowRef<TikzLivePreviewState>(EMPTY_STATE)
const fullscreen = ref(false)
const previewMode = ref<PreviewMode>(props.target.language === 'tikzcd' ? 'quiver' : 'tikz')
const quiverStatus = ref('Loading Quiver…')
const figureViewer = ref<FigureViewerHandle|null>(null)
const isTikzCd = computed(() => props.target.language === 'tikzcd')
const displayMode = computed<PreviewMode>(() => isTikzCd.value ? previewMode.value : 'tikz')

const controller = new TikzLivePreviewController(
  render,
  next => { state.value = next },
  250
)

function targetIdentity (target: TikzLivePreviewTarget): string {
  return `${target.docPath}\0${target.kind}\0${target.language}\0${target.from}`
}

watch(
  () => targetIdentity(props.target),
  () => {
    previewMode.value = props.target.language === 'tikzcd' ? 'quiver' : 'tikz'
    fullscreen.value = false
  }
)

watch(
  [ () => props.target, displayMode ],
  ([ target, mode ]) => {
    if (mode === 'tikz') {
      controller.setTarget(target)
    }
  },
  { immediate: true }
)

watch(fullscreen, async () => {
  await nextTick()
  figureViewer.value?.fit()
})

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
  controller.dispose()
})

const tikzStatusText = computed(() => {
  if (state.value.failure !== null) {
    return state.value.lastGood === null ? 'Render failed' : 'Last good render'
  }
  if (state.value.pending) {
    return state.value.lastGood === null ? 'Rendering…' : 'Updating…'
  }
  return state.value.lastGood === null ? '' : 'Up to date'
})

const activeStatus = computed(() => displayMode.value === 'quiver' ? quiverStatus.value : tikzStatusText.value)

function summarizeFailure (failure: TikzRenderFailure): string {
  switch (failure.kind) {
    case 'compile-error': {
      const first = failure.errors[0]
      return first === undefined
        ? 'TikZ failed to compile.'
        : `TikZ line ${first.line}: ${first.message}`
    }
    case 'missing-tools':
      return `TikZ tools not found: ${failure.missing.join(', ')}`
    case 'toolchain-probe-failed':
      return `Could not check ${failure.tool}: ${failure.code}`
    case 'pandoc-error':
      return 'TikZ render failed.'
    case 'render-terminated':
      return `TikZ render was terminated by ${failure.signal}.`
    default: {
      const unhandled: never = failure
      return String(unhandled)
    }
  }
}

const failureSummary = computed(() => state.value.failure === null ? '' : summarizeFailure(state.value.failure))

const failureDetails = computed(() => {
  const failure = state.value.failure
  if (failure === null) return ''
  if (failure.kind === 'compile-error') {
    const mapped = failure.errors
      .map(error => `line ${error.line}: ${error.message}\n${error.sourceLine}`)
      .join('\n\n')
    return mapped !== '' ? mapped : failure.log.split('\n').slice(-12).join('\n')
  }
  if (failure.kind === 'pandoc-error' || failure.kind === 'render-terminated') {
    return failure.log.split('\n').slice(-12).join('\n')
  }
  return ''
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

.tikz-live-preview-quiver,
.tikz-live-preview-canvas {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.tikz-live-preview-canvas.stale .tikz-live-preview-figure { opacity: 0.78; }

.tikz-live-preview-figure {
  width: 100%;
  height: 100%;
  min-height: 0;
  transition: opacity 100ms ease;
}

.tikz-live-preview-placeholder {
  height: 100%;
  display: grid;
  place-items: center;
  opacity: 0.55;
  font-style: italic;
  text-align: center;
}

.tikz-live-preview-error {
  flex: 0 0 auto;
  max-height: 32%;
  overflow: auto;
  border-top: 1px solid rgba(192, 57, 43, 0.38);
  padding: 7px 10px;
  color: #a93226;
  background: rgba(192, 57, 43, 0.055);
  font-size: 0.78rem;

  details { margin-top: 4px; }
  summary { cursor: pointer; opacity: 0.8; }
  pre {
    margin: 6px 0 0;
    max-height: 10rem;
    overflow: auto;
    white-space: pre-wrap;
    font-size: 0.75rem;
  }
}

:global(body.dark .tikz-live-preview) {
  border-left-color: #505050;
  background: #252526;
}

:global(body.dark .tikz-live-preview-header) {
  border-bottom-color: #444;
}

:global(body.dark .tikz-live-preview-error) {
  color: #e67e73;
  background: rgba(192, 57, 43, 0.08);
}
</style>
