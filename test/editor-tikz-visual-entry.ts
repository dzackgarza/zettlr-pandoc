/**
 * Mounts the production TikZ figure renderer and unified RHS preview
 * for isolated visual capture (issue #14). The capture harness computes real
 * render results through the main-process service (real pdflatex + pdf2svg)
 * and injects them as window.__tikzResponses; the page's window.ipc seam
 * resolves from that map, so the widgets exercise the production async path
 * with production render output.
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { renderTikzFigures } from "source/common/modules/markdown-editor/renderers/render-tikz";
import {
  defaultDark,
  defaultLight,
  editorTheme,
} from "source/common/modules/markdown-editor/theme/editor";
import { markdownSyntaxHighlighter } from "source/common/modules/markdown-editor/theme/syntax";
import { activeTikzBlock } from "source/common/modules/markdown-editor/tikz-block";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { zettlrTikzWorkbenchHost } from "source/win-main/tikz-workbench-host";
import type { TikzRenderRequest, TikzRenderResult } from "tikz-workbench/src/tikz-render";
import TikzWorkbench from "tikz-workbench/src/ui/TikzWorkbench.vue";
import { createApp } from "vue";

declare global {
  interface Window {
    captureReady: Promise<void>;
    __tikzResponses: Record<string, TikzRenderResult>;
    __tikzRequests: TikzRenderRequest[];
  }
}

import {
  SCENE_DOC,
  TEXTBOOK_MEDIUM_SCENE_DOC,
  TEXTBOOK_SMALL_SCENE_DOC,
  TEXTBOOK_WIDE_SCENE_DOC,
} from "./editor-tikz-scene-doc";
import { stacksReplicaDocument } from "./tikz-stacks-reference";

async function mount(): Promise<void> {
  const dark = document.body.dataset.dark === "true";
  const scene = document.body.dataset.scene;
  const livePreview = scene === "live";
  const documentText =
    scene?.startsWith("stacks-") === true
      ? stacksReplicaDocument(scene.slice("stacks-".length))
      : scene === "textbook-small"
        ? TEXTBOOK_SMALL_SCENE_DOC
        : scene === "textbook-medium"
          ? TEXTBOOK_MEDIUM_SCENE_DOC
          : scene === "textbook-wide"
            ? TEXTBOOK_WIDE_SCENE_DOC
            : SCENE_DOC;
  window.__tikzRequests = [];

  // The seam resolves from the harness-injected response map, keyed exactly
  // as the widget requests render (kind NUL language NUL source).
  window.ipc = {
    invoke: async (channel: string, message: { command: string; payload: TikzRenderRequest }) => {
      if (channel === "quiver-macros") {
        return { macros: {}, unsupported: [] };
      }
      window.__tikzRequests.push(message.payload);
      // The driver obtains raw blocks from fixture text while CodeMirror hands
      // this page the parser-owned paragraph range. Their only admissible
      // difference is outer paragraph whitespace; render semantics and cache
      // keys still use the exact production request itself.
      const key = `${message.payload.kind}\0${message.payload.language}\0${message.payload.source.trim()}`;
      const response = window.__tikzResponses[key];
      if (response === undefined) {
        throw new Error(`no injected render response for request: ${key.slice(0, 80)}`);
      }
      return response;
    },
    on: () => () => {},
    send: () => {},
    sendSync: () => undefined,
  } as any;

  const state = EditorState.create({
    doc: documentText,
    selection: {
      anchor: livePreview ? documentText.indexOf('A \\arrow[r, "f"]') + 4 : documentText.length,
    },
    extensions: [
      markdownParser(),
      markdownSyntaxHighlighter(),
      configField,
      EditorView.lineWrapping,
      editorTheme,
      dark ? defaultDark : defaultLight,
      renderTikzFigures,
    ],
  });

  const host = document.querySelector<HTMLElement>("#editor");
  if (host === null) {
    throw new Error("Visual capture host is missing");
  }
  const view = new EditorView({ state, parent: host });
  view.focus();

  if (livePreview) {
    const block = activeTikzBlock(view.state);
    if (block === null) {
      throw new Error("Live TikZ visual scene caret did not resolve to its raw TikZ block");
    }
    const previewHost = document.querySelector<HTMLElement>("#tikz-live-preview-host");
    if (previewHost === null) {
      throw new Error("Live TikZ visual preview host is missing");
    }
    createApp(TikzWorkbench, {
      target: {
        ...block,
        docPath: "",
        authoredSource: view.state.sliceDoc(block.sourceFrom, block.sourceTo),
      },
      host: zettlrTikzWorkbenchHost(view),
      theme: dark ? "dark" : "light",
    }).mount(previewHost);
    // The visual corpus exercises the compiler-backed TikZ rendering surface;
    // tikzcd correctly defaults to Quiver in production, so opt into TikZ here.
    previewHost
      .querySelector<HTMLButtonElement>(".tikz-live-preview-modes button:first-child")
      ?.click();
  }

  // Wait until either the ordinary inline scene or the microlocal split has
  // reached a complete production render.
  for (let round = 0; round < 200; round++) {
    const svgs = document.querySelectorAll(".tikz-figure svg").length;
    const errors = document.querySelectorAll(".tikz-error").length;
    const liveViewer =
      document.querySelector(".tikz-live-preview-figure .tikz-workbench-viewerjs") !== null;
    if (
      (scene?.startsWith("stacks-") === true && svgs >= (scene === "stacks-01JO" ? 3 : 1)) ||
      (scene?.startsWith("textbook-") === true && svgs >= (scene === "textbook-small" ? 4 : 3)) ||
      (scene?.startsWith("textbook-") !== true && !livePreview && svgs >= 2 && errors >= 1) ||
      (livePreview && liveViewer && svgs >= 1 && errors >= 1)
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  const errorTexts = Array.from(document.querySelectorAll(".tikz-error")).map((box) =>
    box.textContent?.slice(0, 160),
  );
  throw new Error(
    `TikZ widgets never reached the expected rendered state: live=${String(livePreview)} figures=${document.querySelectorAll(".tikz-figure").length} svgs=${document.querySelectorAll(".tikz-figure svg").length} liveViewer=${String(document.querySelector(".tikz-live-preview-figure .tikz-workbench-viewerjs") !== null)} errors=${JSON.stringify(errorTexts)}`,
  );
}

window.captureReady = mount();
