<template>
  <div class="tikz-editor-preview" :class="{ dark: props.theme === 'dark' }">
    <div
      v-if="errorMessage !== ''"
      class="tikz-editor-error"
      role="status"
    >
      {{ errorMessage }}
    </div>
    <iframe
      ref="frame"
      class="tikz-editor-frame"
      :src="props.host.editorUrl"
      title="TikZ visual editor"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Vendored tikz-editor preview provider
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Hosts the pinned DominikPeters/tikz-editor fork in an
 *                  isolated iframe. The host document remains the source authority;
 *                  tikz-editor owns TikZ parsing, semantics, canvas editing,
 *                  edit capabilities and history. The bridge sends complete
 *                  source in both directions and rejects stale iframe writes.
 *
 * END HEADER
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  type TikzEditorSourceSession,
  tikzEditorReplacement,
  tikzEditorSessionForBlock,
} from "../editor-bridge";
import type { TikzWorkbenchHost, TikzWorkbenchTheme } from "../host";
import type { TikzLivePreviewTarget } from "../live-preview";

interface PreviewSession {
  id: string;
  revision: number;
  source: TikzEditorSourceSession;
}

interface TikzEditorHostMessage {
  event?: string;
  revision?: number;
  source?: string;
  xml?: string;
  message?: string;
  title?: string;
  kind?: string;
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
  (e: "busy", busy: boolean): void;
}>();

const frame = ref<HTMLIFrameElement | null>(null);
const session = shallowRef<PreviewSession>({
  id: crypto.randomUUID(),
  revision: 0,
  source: tikzEditorSessionForBlock(props.target),
});
const hostReady = ref(false);
const loaded = ref(false);
const errorMessage = ref("");

function sameBlockIdentity(a: TikzEditorSourceSession, b: TikzEditorSourceSession): boolean {
  return a.kind === b.kind && a.blockFrom === b.blockFrom;
}

function postToEditor(message: Record<string, unknown>): void {
  const target = frame.value?.contentWindow;
  if (target === undefined || target === null) {
    return;
  }
  target.postMessage(message, "*");
}

function sendFullLoad(): void {
  if (!hostReady.value) {
    return;
  }
  const active = session.value;
  const revision = active.revision + 1;
  session.value = { ...active, revision };
  loaded.value = false;
  postToEditor({
    action: "load",
    revision,
    source: active.source.source,
    autosave: 0,
    fileName: props.target.docPath === "" ? "diagram.tikz" : props.target.docPath,
    imageBaseUrl: props.host.imageBaseUrl(props.target.docPath),
    settings: {
      general: {
        colorScheme: props.theme,
        canvasInvert: false,
      },
    },
  });
  postToEditor({ action: "display", fullscreen: props.fullscreen });
}

function sendTheme(): void {
  if (!hostReady.value) {
    return;
  }
  postToEditor({
    action: "settings",
    settings: { general: { colorScheme: props.theme, canvasInvert: false } },
  });
}

watch(
  () => props.target,
  (target) => {
    const next = tikzEditorSessionForBlock(target);
    const active = session.value;
    const sameIdentity = sameBlockIdentity(active.source, next);
    const sameSource = sameIdentity && active.source.source === next.source;

    if (!sameIdentity) {
      session.value = { id: crypto.randomUUID(), revision: 0, source: next };
      errorMessage.value = "";
      sendFullLoad();
      return;
    }

    // Edits elsewhere in the Markdown document may move the source range
    // without changing this TikZ block. Keep tikz-editor's history intact and
    // refresh only the authority coordinates used for the next write-back.
    session.value = { ...active, source: next };
    if (!sameSource) {
      errorMessage.value = "";
      sendFullLoad();
    }
  },
);

watch(() => props.theme, sendTheme);

watch(
  () => props.fullscreen,
  (fullscreen) => {
    if (hostReady.value) {
      postToEditor({ action: "display", fullscreen });
    }
  },
);

function parseHostMessage(data: unknown): TikzEditorHostMessage | null {
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed !== null && typeof parsed === "object"
        ? (parsed as TikzEditorHostMessage)
        : null;
    } catch {
      return null;
    }
  }
  return data !== null && typeof data === "object" ? (data as TikzEditorHostMessage) : null;
}

function applyEditorSource(source: string, revision: number | undefined): void {
  const active = session.value;
  if (revision !== active.revision) {
    return;
  }
  if (source === active.source.source) {
    return;
  }

  // The host document may have changed after tikz-editor began this edit. Never let
  // a delayed iframe message overwrite newer authoritative source bytes.
  const current = props.host.readSource(active.source.sourceFrom, active.source.sourceTo);
  if (current !== active.source.source) {
    return;
  }

  try {
    const replacement = tikzEditorReplacement(active.source, source);
    props.host.writeSource(replacement.from, replacement.to, replacement.insert);
    session.value = { ...active, source: replacement.next };
    errorMessage.value = "";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    props.host.reportError("Could not synchronize tikz-editor source into the document", error);
  }
}

function onMessage(event: MessageEvent): void {
  if (event.source !== frame.value?.contentWindow) {
    return;
  }
  const message = parseHostMessage(event.data);
  if (message === null) {
    return;
  }

  switch (message.event) {
    case "init":
      hostReady.value = true;
      sendFullLoad();
      break;
    case "loaded":
      if (message.revision !== session.value.revision) {
        break;
      }
      loaded.value = true;
      errorMessage.value = "";
      break;
    case "change":
    case "autosave":
    case "save": {
      const source =
        typeof message.source === "string"
          ? message.source
          : typeof message.xml === "string"
            ? message.xml
            : null;
      if (source !== null) {
        applyEditorSource(source, message.revision);
      }
      break;
    }
    case "message":
      if (message.kind === "error") {
        errorMessage.value = message.message ?? message.title ?? "tikz-editor reported an error.";
      }
      break;
    case "close-request":
      if (props.fullscreen) {
        emit("exitFullscreen");
      }
      break;
  }
}

const statusText = computed(() => {
  if (errorMessage.value !== "") {
    return "Synchronization issue";
  }
  if (!hostReady.value) {
    return "Loading tikz-editor…";
  }
  return loaded.value ? "Synced" : "Loading source…";
});

watch(
  statusText,
  (text) => {
    emit("status", text);
  },
  { immediate: true },
);
emit("busy", false);

onMounted(() => {
  window.addEventListener("message", onMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
});
</script>

<style scoped lang="less">
.tikz-editor-preview {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.tikz-editor-frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: white;
}

.tikz-editor-error {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(192, 57, 43, 0.35);
  background: rgba(192, 57, 43, 0.08);
  color: #a93226;
  font-size: 0.8rem;
}

.tikz-editor-preview.dark .tikz-editor-error {
  color: #e67e73;
}
</style>
