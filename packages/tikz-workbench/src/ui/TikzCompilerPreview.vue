<template>
  <div class="tikz-compiler-preview" :class="{ dark: props.theme === 'dark' }">
    <div
      v-if="state.failure === null || state.lastGood !== null"
      class="tikz-compiler-preview-canvas tikz-live-preview-canvas"
      :class="{ stale: state.stale || state.failure !== null }"
    >
      <TikzFigureViewer
        v-if="state.lastGood !== null"
        ref="figureViewer"
        class="tikz-compiler-preview-figure tikz-live-preview-figure"
        :src="props.host.figureUrl(state.lastGood.result)"
        :data-svg-path="state.lastGood.result.svgPath"
        :theme="props.theme"
        :show-fullscreen-button="false"
      />
      <div
        v-else-if="state.pending"
        class="tikz-compiler-preview-placeholder tikz-live-preview-placeholder"
      >
        Rendering TikZ…
      </div>
      <div
        v-else
        class="tikz-compiler-preview-placeholder tikz-live-preview-placeholder"
      >
        No successful render yet.
      </div>
    </div>

    <div
      v-if="state.failure !== null"
      class="tikz-compiler-preview-error tikz-live-preview-error"
      role="status"
    >
      <div class="tikz-compiler-preview-error-header">
        <strong>{{ failureSummary }}</strong>
        <button type="button" @click="copyDiagnostics">Copy diagnostics</button>
      </div>
      <pre v-if="failureDetails !== ''">{{ failureDetails }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Compiler-backed TikZ preview provider
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Owns the debounced Pandoc/TeX preview renderer. It implements the same provider
 *                  surface as Quiver and the visual editor: target in, status
 *                  out, optional refresh handle. The outer sidecar therefore
 *                  has no compiler-specific rendering branch.
 *
 * END HEADER
 */

import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { tikzCompilerLogHeadline } from "../compiler-log";
import type { TikzWorkbenchHost, TikzWorkbenchTheme } from "../host";
import {
  TikzLivePreviewController,
  type TikzLivePreviewState,
  type TikzLivePreviewTarget,
  type TikzRenderFailure,
} from "../live-preview";
import type { TikzRenderRequest, TikzRenderResult } from "../tikz-render";
import TikzFigureViewer from "./TikzFigureViewer.vue";

const props = defineProps<{
  target: TikzLivePreviewTarget;
  host: TikzWorkbenchHost;
  theme: TikzWorkbenchTheme;
  fullscreen: boolean;
}>();

const emit = defineEmits<{
  (e: "status", text: string): void;
  (e: "busy", busy: boolean): void;
}>();

interface FigureViewerHandle {
  fit: () => void;
}

async function render(request: TikzRenderRequest): Promise<TikzRenderResult> {
  try {
    return await props.host.render(request);
  } catch (error) {
    props.host.reportError("TikZ render request failed", error);
    return {
      ok: false,
      kind: "pandoc-error",
      log: error instanceof Error ? error.message : String(error),
    };
  }
}

const EMPTY_STATE: TikzLivePreviewState = {
  target: null,
  lastGood: null,
  failure: null,
  pending: false,
  rendering: false,
  stale: false,
};

const state = shallowRef<TikzLivePreviewState>(EMPTY_STATE);
const figureViewer = ref<FigureViewerHandle | null>(null);
const controller = new TikzLivePreviewController(
  render,
  (next) => {
    state.value = next;
  },
  250,
);

watch(
  () => props.target,
  (target) => {
    controller.setTarget(target);
  },
  { immediate: true },
);

watch(
  () => props.fullscreen,
  async () => {
    await nextTick();
    figureViewer.value?.fit();
  },
);

const statusText = computed(() => {
  if (state.value.failure !== null) {
    return state.value.lastGood === null ? "Render failed" : "Last good render";
  }
  if (state.value.pending) {
    return state.value.lastGood === null ? "Rendering…" : "Updating…";
  }
  return state.value.lastGood === null ? "" : "Up to date";
});

watch(
  statusText,
  (text) => {
    emit("status", text);
  },
  { immediate: true },
);
watch(
  () => state.value.rendering,
  (busy) => {
    emit("busy", busy);
  },
  { immediate: true },
);

function summarizeFailure(failure: TikzRenderFailure): string {
  switch (failure.kind) {
    case "compile-error": {
      const first = failure.errors[0];
      if (first !== undefined) return `TikZ line ${first.line}: ${first.message}`;
      const headline = tikzCompilerLogHeadline(failure.log);
      return headline === null ? "TikZ failed to compile without compiler output." : headline;
    }
    case "missing-tools":
      return `TikZ tools not found: ${failure.missing.join(", ")}`;
    case "toolchain-probe-failed":
      return `Could not check ${failure.tool}: ${failure.code}`;
    case "pandoc-error": {
      const headline = tikzCompilerLogHeadline(failure.log);
      return headline === null ? "Pandoc returned no diagnostic." : headline;
    }
    case "render-terminated":
      return `TikZ render was terminated by ${failure.signal}.`;
    default: {
      const unhandled: never = failure;
      return String(unhandled);
    }
  }
}

const failureSummary = computed(() =>
  state.value.failure === null ? "" : summarizeFailure(state.value.failure),
);

const failureDetails = computed(() => {
  const failure = state.value.failure;
  if (failure === null) {
    return "";
  }
  if (failure.kind === "compile-error") {
    return (
      failure.log ||
      failure.errors
        .map((error) => `line ${error.line}: ${error.message}\n${error.sourceLine}`)
        .join("\n\n")
    );
  }
  if (failure.kind === "pandoc-error" || failure.kind === "render-terminated") {
    return failure.log;
  }
  return "";
});

function copyDiagnostics(): void {
  void navigator.clipboard
    .writeText(failureDetails.value || failureSummary.value)
    .catch((error) => {
      props.host.reportError("Could not copy TikZ diagnostics", error);
    });
}

function refresh(): void {
  controller.forceRender();
}

defineExpose({ refresh });

onBeforeUnmount(() => {
  controller.dispose();
});
</script>

<style scoped lang="less">
.tikz-compiler-preview {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tikz-compiler-preview-canvas {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.tikz-compiler-preview-canvas.stale .tikz-compiler-preview-figure { opacity: 0.78; }

// With a last good figure above it, the complete log takes at most half the height.
.tikz-compiler-preview-canvas + .tikz-compiler-preview-error {
  flex: 0 1 auto;
  max-height: 50%;
}

.tikz-compiler-preview-figure {
  width: 100%;
  height: 100%;
  min-height: 0;
  transition: opacity 100ms ease;
}

.tikz-compiler-preview-placeholder {
  height: 100%;
  display: grid;
  place-items: center;
  opacity: 0.55;
  font-style: italic;
  text-align: center;
}

.tikz-compiler-preview-error {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  border-top: 1px solid rgba(192, 57, 43, 0.38);
  padding: 7px 10px;
  color: #a93226;
  background: rgba(192, 57, 43, 0.055);
  font-size: 0.78rem;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;

  * {
    user-select: text;
    -webkit-user-select: text;
  }

  .tikz-compiler-preview-error-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  button { cursor: pointer; }
  pre {
    margin: 8px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
  }
}

.tikz-compiler-preview.dark .tikz-compiler-preview-error {
  color: #e67e73;
  background: rgba(192, 57, 43, 0.08);
}
</style>
