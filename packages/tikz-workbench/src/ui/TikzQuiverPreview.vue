<template>
  <div class="tikz-quiver-preview" :class="{ dark: props.theme === 'dark' }">
    <div
      v-if="errorMessage !== ''"
      class="tikz-quiver-error"
      role="status"
    >
      {{ errorMessage }}
    </div>
    <iframe
      ref="frame"
      class="tikz-quiver-frame"
      :src="props.host.quiverUrl"
      title="Quiver diagram editor"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzQuiverPreview
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Reusable local host for the forked/vendored Quiver editor.
 *                  The RHS preview pane owns presentation mode and fullscreen
 *                  geometry; this component owns only the live document ↔
 *                  Quiver source bridge, macro projection and theme forwarding.
 *                  Embedded and fullscreen states therefore use the same iframe
 *                  and Quiver history rather than competing editor instances.
 *
 * END HEADER
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { TikzWorkbenchHost, TikzWorkbenchTheme } from "../host";
import type { TikzLivePreviewTarget } from "../live-preview";
import {
  quiverReplacement,
  quiverSessionForBlock,
  quiverSourceForSession,
  type TikzQuiverSourceSession,
} from "../quiver-bridge";
import type { QuiverMacroProjection } from "../quiver-macros";

interface PreviewSession {
  id: string;
  source: TikzQuiverSourceSession;
}

interface QuiverDiagnostic {
  severity: "warning" | "error";
  message: string;
  from: number;
  to: number;
}

interface QuiverHostMessage {
  type: string;
  sessionId?: string | null;
  source?: string;
  message?: string;
  diagnostics?: QuiverDiagnostic[];
}

const props = defineProps<{
  target: TikzLivePreviewTarget;
  host: TikzWorkbenchHost;
  theme: TikzWorkbenchTheme;
  fullscreen: boolean;
}>();

const emit = defineEmits<{
  (e: "exitFullscreen"): void;
  (e: "status", text: string): void;
}>();

const frame = ref<HTMLIFrameElement | null>(null);
const session = shallowRef<PreviewSession>({
  id: crypto.randomUUID(),
  source: quiverSessionForBlock(props.target),
});
const macroProjection = shallowRef<QuiverMacroProjection | null>(null);
const hostReady = ref(false);
const diagnostics = ref<QuiverDiagnostic[]>([]);
const errorMessage = ref("");

function sameBlockIdentity(a: TikzQuiverSourceSession, b: TikzQuiverSourceSession): boolean {
  return a.kind === b.kind && a.blockFrom === b.blockFrom;
}

function postToQuiver(message: Record<string, unknown>): void {
  const target = frame.value?.contentWindow;
  if (target === undefined || target === null) return;
  target.postMessage({ ...message, sessionId: session.value.id }, "*");
}

function sendFullLoad(): void {
  if (!hostReady.value || macroProjection.value === null) return;
  postToQuiver({
    type: "zettlr-quiver:load",
    source: quiverSourceForSession(session.value.source),
    macros: macroProjection.value.macros,
    theme: props.theme,
  });
  postToQuiver({ type: "zettlr-quiver:display", fullscreen: props.fullscreen });
}

function sendSourceUpdate(): void {
  if (!hostReady.value || macroProjection.value === null) return;
  postToQuiver({
    type: "zettlr-quiver:source",
    source: quiverSourceForSession(session.value.source),
    macros: macroProjection.value.macros,
  });
}

watch(
  () => props.target,
  (target) => {
    if (target.language !== "tikzcd") {
      throw new Error(`Quiver can only edit tikzcd diagrams, not ${target.language}`);
    }
    const next = quiverSessionForBlock(target);
    const active = session.value;
    const sameIdentity = sameBlockIdentity(active.source, next);
    const sameSource = sameIdentity && active.source.source === next.source;

    if (!sameIdentity) {
      session.value = { id: crypto.randomUUID(), source: next };
      diagnostics.value = [];
      errorMessage.value = "";
      sendFullLoad();
      return;
    }

    // Range movement without byte changes can happen when the document changes
    // before this block. Keep the current Quiver history but refresh its source
    // authority coordinates.
    session.value = { ...active, source: next };
    if (!sameSource) {
      diagnostics.value = [];
      errorMessage.value = "";
      sendSourceUpdate();
    }
  },
);

watch(
  () => props.theme,
  (theme) => {
    if (hostReady.value) {
      postToQuiver({ type: "zettlr-quiver:theme", theme });
    }
  },
);

watch(
  () => props.fullscreen,
  (fullscreen) => {
    if (hostReady.value) {
      postToQuiver({ type: "zettlr-quiver:display", fullscreen });
    }
  },
);

function onMessage(event: MessageEvent<QuiverHostMessage>): void {
  if (event.source !== frame.value?.contentWindow) return;
  const message = event.data;
  if (message === null || typeof message !== "object") return;

  if (message.type === "zettlr-quiver:ready") {
    hostReady.value = true;
    sendFullLoad();
    return;
  }
  if (message.sessionId !== session.value.id) return;

  switch (message.type) {
    case "zettlr-quiver:loaded":
      diagnostics.value = Array.isArray(message.diagnostics) ? message.diagnostics : [];
      errorMessage.value = "";
      break;
    case "zettlr-quiver:change": {
      if (typeof message.source !== "string") return;
      const active = session.value;
      const current = props.host.readSource(active.source.sourceFrom, active.source.sourceTo);
      if (current !== active.source.authoredSource) {
        // The host document changed first. The host will update the
        // target prop and reload Quiver from the newer authority bytes; never
        // overwrite that source with a stale iframe export.
        return;
      }
      try {
        const replacement = quiverReplacement(active.source, message.source);
        props.host.writeSource(replacement.from, replacement.to, replacement.insert);
        session.value = { ...active, source: replacement.next };
        errorMessage.value = "";
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
        props.host.reportError("Could not synchronize Quiver source into the document", error);
      }
      break;
    }
    case "zettlr-quiver:error":
      errorMessage.value = message.message ?? "Quiver reported an unknown error.";
      break;
    case "zettlr-quiver:close-request":
      if (props.fullscreen) emit("exitFullscreen");
      break;
  }
}

const statusText = computed(() => {
  if (errorMessage.value !== "") return "Synchronization issue";
  const errors = diagnostics.value.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.value.filter((item) => item.severity === "warning").length;
  if (errors > 0) return `${errors} import error${errors === 1 ? "" : "s"}`;
  if (warnings > 0) return `${warnings} import warning${warnings === 1 ? "" : "s"}`;
  if (!hostReady.value) return "Loading Quiver…";
  const compilerOnly = macroProjection.value?.unsupported.length ?? 0;
  return compilerOnly > 0
    ? `Synced · ${compilerOnly} macro${compilerOnly === 1 ? "" : "s"} unavailable in Quiver`
    : "Synced";
});

watch(
  statusText,
  (text) => {
    emit("status", text);
  },
  { immediate: true },
);

onMounted(async () => {
  window.addEventListener("message", onMessage);

  try {
    macroProjection.value = await props.host.quiverMacros();
    sendFullLoad();
  } catch (error) {
    errorMessage.value = `Could not load Quiver macros: ${error instanceof Error ? error.message : String(error)}`;
    props.host.reportError("Quiver macro projection failed", error);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
});
</script>

<style scoped lang="less">
.tikz-quiver-preview {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.tikz-quiver-frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: white;
}

.tikz-quiver-error {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(192, 57, 43, 0.35);
  background: rgba(192, 57, 43, 0.08);
  color: #a93226;
  font-size: 0.8rem;
}

.tikz-quiver-preview.dark .tikz-quiver-error {
  color: #e67e73;
}
</style>
