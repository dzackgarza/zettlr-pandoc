import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { contiguousSourceLineRanges } from "source/common/util/tikz-source-blocks";
import { type Component, createApp, nextTick } from "vue";

declare global {
  interface Window {
    tikzEditorFullscreenReady: Promise<void>;
  }
}

const source = ["\\begin{tikzpicture}", "\\draw (0,0) -- (1,1);", "\\end{tikzpicture}"].join("\n");
const previewContext = require.context("../source/win-main/", false, /TikzLivePreview\.vue$/);

function tikzLivePreviewComponent(): Component {
  const key = previewContext.keys().find((candidate) => candidate.includes("TikzLivePreview"));
  if (key === undefined) {
    throw new Error("source/win-main/TikzLivePreview.vue is missing from the renderer bundle");
  }
  const module = previewContext(key) as { default?: unknown };
  if (module.default === undefined) {
    throw new Error("source/win-main/TikzLivePreview.vue has no default component export");
  }
  return module.default as Component;
}

async function mount(): Promise<void> {
  const ipcSeam = {
    invoke: async (channel: string): Promise<unknown> => {
      if (channel === "tikz-render") {
        return {
          ok: true,
          html: '<div><svg width="10pt" height="10pt" viewBox="0 0 10 10"></svg></div>',
          svg: '<svg width="10pt" height="10pt" viewBox="0 0 10 10"></svg>',
          svgPath: "/tmp/probe.svg",
          texFontSizePt: 10,
        };
      }
      return undefined;
    },
    on: () => () => {},
    send: () => {},
    sendSync: () => undefined,
  };
  Object.defineProperty(window, "ipc", {
    configurable: true,
    writable: true,
    value: ipcSeam,
  });

  const editorHost = document.querySelector<HTMLElement>("#editor");
  const previewHost = document.querySelector<HTMLElement>("#preview");
  if (editorHost === null || previewHost === null) {
    throw new Error("TikZ fullscreen probe hosts are missing");
  }

  const view = new EditorView({
    state: EditorState.create({ doc: source }),
    parent: editorHost,
  });
  createApp(tikzLivePreviewComponent(), {
    target: {
      from: 0,
      to: source.length,
      sourceFrom: 0,
      sourceTo: source.length,
      source,
      sourceLineRanges: contiguousSourceLineRanges(source, 0),
      kind: "raw",
      language: "tikz",
      docPath: "/tmp/fullscreen-probe.tikz",
    },
    editorView: view,
  }).mount(previewHost);
  await nextTick();
}

window.tikzEditorFullscreenReady = mount();
