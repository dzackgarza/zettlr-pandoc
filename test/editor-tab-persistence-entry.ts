import { createPinia } from "pinia";
import type { EditorCommands } from "source/win-main/component-contracts";
import { type Component, createApp, nextTick } from "vue";

declare global {
  interface Window {
    tabPersistenceReady: Promise<void>;
    tabPersistenceNext: () => void;
    tabPersistencePrevious: () => void;
    tabPersistenceState: () => {
      activePath: string | null;
      editorCount: number;
      activeEditorProbeId: string | null;
      activeScrollTop: number | null;
      fetchCounts: Record<string, number>;
    };
    __tabProbeEmit: (channel: string, ...args: unknown[]) => void;
    __tabProbeFetchCounts: Record<string, number>;
  }
}

const editorCommands: EditorCommands = {
  jumpToLine: false,
  moveSection: false,
  addKeywords: false,
  replaceSelection: false,
  insertPandoc: false,
  executeCommand: false,
  setLanguageToolLanguage: false,
  data: undefined,
};

const paneContext = require.context("../source/win-main/", false, /EditorPane\.vue$/);

function editorPaneComponent(): Component {
  const paneKey = paneContext.keys().find((key) => key.includes("EditorPane"));
  if (paneKey === undefined) {
    throw new Error("source/win-main/EditorPane.vue is missing from the renderer bundle");
  }
  const paneModule = paneContext(paneKey) as { default?: unknown };
  if (paneModule.default === undefined) {
    throw new Error("source/win-main/EditorPane.vue has no default component export");
  }
  return paneModule.default as Component;
}

function visibleEditorWrapper(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>(".main-editor-wrapper")).find(
      (wrapper) => getComputedStyle(wrapper).display !== "none",
    ) ?? null
  );
}

async function mount(): Promise<void> {
  const host = document.querySelector("#app");
  if (host === null) {
    throw new Error("Tab persistence probe host is missing");
  }

  createApp(editorPaneComponent(), {
    leafId: "probe-leaf",
    windowId: "probe-window",
    editorCommands,
  })
    .use(createPinia())
    .mount(host);

  await nextTick();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const poll = (): void => {
      const editor = visibleEditorWrapper()?.querySelector<HTMLElement>(".cm-editor");
      if (
        editor !== undefined &&
        editor !== null &&
        editor.querySelectorAll(".cm-line").length > 0
      ) {
        resolve();
        return;
      }
      if (performance.now() - started > 5000) {
        reject(new Error("Initial probe editor did not render"));
        return;
      }
      requestAnimationFrame(poll);
    };
    poll();
  });
}

window.tabPersistenceNext = () => {
  window.__tabProbeEmit("shortcut", "next-tab");
};

window.tabPersistencePrevious = () => {
  window.__tabProbeEmit("shortcut", "previous-tab");
};

window.tabPersistenceState = () => {
  const wrapper = visibleEditorWrapper();
  const editor = wrapper?.querySelector<HTMLElement>(".cm-editor") ?? null;
  const scroller = wrapper?.querySelector<HTMLElement>(".cm-scroller") ?? null;
  return {
    activePath: document.querySelector<HTMLElement>(".tab-container .active")?.dataset.path ?? null,
    editorCount: document.querySelectorAll(".cm-editor").length,
    activeEditorProbeId: editor?.dataset.tabPersistenceProbe ?? null,
    activeScrollTop: scroller?.scrollTop ?? null,
    fetchCounts: { ...window.__tabProbeFetchCounts },
  };
};

window.tabPersistenceReady = mount();
