import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { zettlrTikzWorkbenchHost } from "source/win-main/tikz-workbench-host";
import { contiguousSourceLineRanges } from "tikz-workbench/src/source-block";
import TikzWorkbench from "tikz-workbench/src/ui/TikzWorkbench.vue";
import { createApp, nextTick } from "vue";

declare global {
  interface Window {
    tikzEditorFullscreenReady: Promise<void>;
  }
}

const source = ["\\begin{tikzpicture}", "\\draw (0,0) -- (1,1);", "\\end{tikzpicture}"].join("\n");

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
  createApp(TikzWorkbench, {
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
      authoredSource: source,
    },
    host: zettlrTikzWorkbenchHost(view),
    theme: "light",
  }).mount(previewHost);
  await nextTick();
}

window.tikzEditorFullscreenReady = mount();
