<template>
  <div class="tikz-compiler-preview">
    <div
      class="tikz-compiler-preview-canvas tikz-live-preview-canvas"
      :class="{ stale: state.stale || state.failure !== null }"
    >
      <TikzFigureViewer
        v-if="state.lastGood !== null"
        ref="figureViewer"
        class="tikz-compiler-preview-figure tikz-live-preview-figure"
        :svg-path="state.lastGood.result.svgPath"
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
      <div class="tikz-compiler-preview-error-summary">
        {{ failureSummary }}
      </div>
      <details v-if="failureDetails !== ''">
        <summary>{{ failureDetailsLabel }}</summary>
        <pre>{{ failureDetails }}</pre>
      </details>
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
 * Description:     Owns the debounced Pandoc/TeX preview renderer formerly
 *                  embedded in TikzLivePreview. It implements the same provider
 *                  surface as Quiver and the visual editor: target in, status
 *                  out, optional refresh handle. The outer sidecar therefore
 *                  has no compiler-specific rendering branch.
 *
 * END HEADER
 */

import type { EditorView } from "@codemirror/view";
import {
  TikzLivePreviewController,
  type TikzLivePreviewState,
  type TikzLivePreviewTarget,
  type TikzRenderFailure,
} from "@common/modules/markdown-editor/tikz-live-preview";
import { reportError } from "@common/util/error-reporting";
import { tikzCompilerLogExcerpt, tikzCompilerLogHeadline } from "@common/util/tikz-compiler-log";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import TikzFigureViewer from "./TikzFigureViewer.vue";

const props = defineProps<{
  target: TikzLivePreviewTarget;
  editorView: EditorView;
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
    return await window.ipc.invoke("application", {
      command: "tikz-render",
      payload: request,
    });
  } catch (error) {
    reportError("TikZ live preview IPC failed", error);
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
      return first === undefined
        ? tikzCompilerLogHeadline(failure.log) || "TikZ failed to compile without compiler output."
        : `TikZ line ${first.line}: ${first.message}`;
    }
    case "missing-tools":
      return `TikZ tools not found: ${failure.missing.join(", ")}`;
    case "toolchain-probe-failed":
      return `Could not check ${failure.tool}: ${failure.code}`;
    case "pandoc-error":
      return "TikZ render failed.";
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
    const mapped = failure.errors
      .map((error) => `line ${error.line}: ${error.message}\n${error.sourceLine}`)
      .join("\n\n");
    const compilerLog = tikzCompilerLogExcerpt(failure.log, 32);
    return [mapped, compilerLog].filter((part) => part !== "").join("\n\nCompiler log:\n");
  }
  if (failure.kind === "pandoc-error" || failure.kind === "render-terminated") {
    return failure.log.split("\n").slice(-12).join("\n");
  }
  return "";
});

const failureDetailsLabel = computed(() =>
  state.value.failure?.kind === "compile-error" ? "Compiler diagnostics" : "Details",
);

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

:global(body.dark .tikz-compiler-preview-error) {
  color: #e67e73;
  background: rgba(192, 57, 43, 0.08);
}
</style>
