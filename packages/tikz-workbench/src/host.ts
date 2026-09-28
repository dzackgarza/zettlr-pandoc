/**
 * The boundary between the TikZ workbench and the application that embeds it.
 * The host owns the document that stores the TikZ source, the TeX toolchain,
 * the macro projection and every URL; the workbench owns editing, preview and
 * drawing. Zettlr supplies a CodeMirror range and its IPC services; the
 * standalone server supplies one .tikz file and HTTP endpoints.
 */

import type { TikzRenderSuccess } from "./live-preview";
import type { QuiverMacroProjection } from "./quiver-macros";
import type { TikzRenderRequest, TikzRenderResult } from "./tikz-render";

export type TikzWorkbenchTheme = "light" | "dark";

export interface TikzWorkbenchHost {
  /** The authored bytes that the source document stores in [from, to). */
  readSource: (from: number, to: number) => string;
  /**
   * Replace [from, to) of the source document. The host then passes the
   * workbench a target that describes the changed document.
   */
  writeSource: (from: number, to: number, insert: string) => void;
  render: (request: TikzRenderRequest) => Promise<TikzRenderResult>;
  quiverMacros: () => Promise<QuiverMacroProjection>;
  /** The URL from which the preview loads a compiled figure. */
  figureUrl: (figure: TikzRenderSuccess) => string;
  /** The URL against which the visual editor resolves image paths in a document. */
  imageBaseUrl: (docPath: string) => string;
  /** The page of the pinned visual editor (vendor/tikz-editor/src/index.html). */
  editorUrl: string;
  /** The page of the pinned Quiver host (vendor/quiver/src/zettlr-host.html). */
  quiverUrl: string;
  reportError: (message: string, error: unknown) => void;
}
