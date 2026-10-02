<template>
  <div class="tikz-standalone" :class="theme">
    <header>
      <strong>{{ fileName }}</strong>
      <button type="button" :disabled="document === null || !dirty" @click="save">Save</button>
      <span class="tikz-standalone-status" role="status">{{ status }}</span>
    </header>
    <main v-if="document !== null && target !== null" :class="{ 'visual-mode': mode === 'visual' }">
      <SourceEditor
        v-show="mode !== 'visual'"
        class="tikz-standalone-source"
        :source="source"
        :theme="theme"
        @change="source = $event"
      />
      <TikzWorkbench
        class="tikz-standalone-workbench"
        :target="target"
        :host="host"
        :requested-mode="target.language === 'tikzcd' ? 'quiver' : 'tikz'"
        :theme="theme"
        @mode="mode = $event"
      />
    </main>
    <pre v-else-if="loadError !== ''" class="tikz-standalone-error" role="alert">{{ loadError }}</pre>
  </div>
</template>

<script setup lang="ts">
/**
 * The standalone TikZ workbench for one .tikz or .tikzcd file. The file is one
 * TikZ block: the source pane and the workbench edit the same text, and the
 * local server (standalone/server.ts) stores it, compiles it and serves the
 * pinned editor pages.
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { TikzWorkbenchHost, TikzWorkbenchTheme } from "../src/host";
import type { TikzLivePreviewTarget } from "../src/live-preview";
import type { TikzPreviewModeId } from "../src/preview-modes";
import type { QuiverMacroProjection } from "../src/quiver-macros";
import { contiguousSourceLineRanges, rawTikzEnvironment } from "../src/source-block";
import type { TikzRenderResult } from "../src/tikz-render";
import TikzWorkbench from "../src/ui/TikzWorkbench.vue";
import SourceEditor from "./SourceEditor.vue";

interface StandaloneDocument {
  path: string;
  revision: string;
}

const document = shallowRef<StandaloneDocument | null>(null);
const source = ref("");
const savedSource = ref("");
const loadError = ref("");
const hostError = ref("");
// The visual editor has its own source pane, so the page hides its own in that mode.
const mode = ref<TikzPreviewModeId>("tikz");
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const theme = ref<TikzWorkbenchTheme>(darkScheme.matches ? "dark" : "light");

const dirty = computed(() => source.value !== savedSource.value);
const fileName = computed(() => document.value?.path.split("/").pop() ?? "TikZ workbench");
const status = computed(() => {
  if (hostError.value !== "") return hostError.value;
  if (document.value === null) return loadError.value === "" ? "Loading…" : "Load failed";
  return dirty.value ? "Unsaved changes" : "Saved";
});

const target = computed<TikzLivePreviewTarget | null>(() => {
  if (document.value === null) return null;
  const text = source.value;
  const tikzcd = document.value.path.endsWith(".tikzcd") || rawTikzEnvironment(text) === "tikzcd";
  return {
    from: 0,
    to: text.length,
    sourceFrom: 0,
    sourceTo: text.length,
    source: text,
    sourceLineRanges: contiguousSourceLineRanges(text, 0),
    kind: "raw",
    language: tikzcd ? "tikzcd" : "tikz",
    docPath: document.value.path,
    authoredSource: text,
  };
});

async function responseText(response: Response): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return text;
}

const host: TikzWorkbenchHost = {
  readSource: (from, to) => source.value.slice(from, to),
  writeSource: (from, to, insert) => {
    source.value = source.value.slice(0, from) + insert + source.value.slice(to);
  },
  render: async (request) => {
    const response = await fetch("/api/render", { method: "POST", body: JSON.stringify(request) });
    return JSON.parse(await responseText(response)) as TikzRenderResult;
  },
  quiverMacros: async () => {
    const response = await fetch("/api/quiver-macros");
    return JSON.parse(await responseText(response)) as QuiverMacroProjection;
  },
  figureUrl: (figure) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(figure.svg)}`,
  imageBaseUrl: () => new URL("/tikz-image/", location.href).href,
  editorUrl: "/tikz-editor/index.html",
  quiverUrl: "/quiver/zettlr-host.html",
  reportError: (message, error) => {
    hostError.value = `${message}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message, error);
  },
};

async function load(): Promise<void> {
  try {
    const response = await fetch("/api/document");
    const text = await responseText(response);
    const revision = response.headers.get("etag");
    const path = response.headers.get("x-document-path");
    if (revision === null || path === null) {
      throw new Error("The server answered without the document revision or path");
    }
    source.value = text;
    savedSource.value = text;
    document.value = { path, revision };
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

async function save(): Promise<void> {
  const current = document.value;
  if (current === null) return;
  const text = source.value;
  try {
    const response = await fetch("/api/document", {
      method: "PUT",
      headers: { "if-match": current.revision },
      body: text,
    });
    await responseText(response);
    const revision = response.headers.get("etag");
    if (revision === null) throw new Error("The server saved the file without a new revision");
    document.value = { ...current, revision };
    savedSource.value = text;
    hostError.value = "";
  } catch (error) {
    host.reportError("Could not save the file", error);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    void save();
  }
}

function onSchemeChange(event: MediaQueryListEvent): void {
  theme.value = event.matches ? "dark" : "light";
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  darkScheme.addEventListener("change", onSchemeChange);
  void load();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  darkScheme.removeEventListener("change", onSchemeChange);
});
</script>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}
</style>

<style scoped>
.tikz-standalone {
  display: flex;
  flex-direction: column;
  height: 100%;
  font: 14px system-ui, sans-serif;
  color: #222;
  background: #fff;
}

.tikz-standalone.dark {
  color: #eee;
  background: #1e1e1e;
}

header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.4rem 1rem;
  border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
}

.tikz-standalone-status {
  opacity: 0.7;
  overflow-wrap: anywhere;
}

main {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
}

main.visual-mode {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}

.tikz-standalone-source {
  border-right: 1px solid color-mix(in srgb, currentColor 20%, transparent);
}

.tikz-standalone-error {
  margin: 1rem;
  white-space: pre-wrap;
  color: #c0392b;
}

@media (max-width: 800px) {
  main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
}
</style>
