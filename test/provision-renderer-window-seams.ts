/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer-window preload seam provision
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Importing the production renderer aggregate pulls in
 *                  modules that read the preload bridge at evaluation time
 *                  (render-mermaid registers a config-provider listener on
 *                  window.ipc). Import this module FIRST in specs that import
 *                  the aggregate; it provisions the same seams every renderer
 *                  window provides. It never fabricates behavior — listeners
 *                  are recorded no-ops.
 *
 * END HEADER
 */

import type { CitationDatabase } from "source/types/common/citeproc";

interface CitationRequest {
  command?: string;
  payload?: { database?: CitationDatabase; citations?: CiteItem[]; composite?: boolean };
}

if (window.ipc === undefined) {
  const ipc = {
    on: () => () => {},
    invoke: async (channel: string, message?: CitationRequest) => {
      const payload = message?.payload;
      if (channel !== "citeproc-provider" || message?.command !== "get-citation") {
        return undefined;
      }
      if (payload?.database === undefined) {
        throw new Error("renderer seam received get-citation without a database");
      }
      return window.getCitationCallback(payload.database)(
        payload.citations ?? [],
        payload.composite ?? false,
      );
    },
    send: () => {},
    sendSync: () => undefined,
  };
  Object.defineProperty(window, "ipc", { configurable: true, writable: true, value: ipc });
  Object.defineProperty(globalThis, "ipc", { configurable: true, writable: true, value: ipc });
}

if (typeof window.getCitationCallback !== "function") {
  const getCitationCallback: Window["getCitationCallback"] = () => (citations) =>
    citations.map((citation) => citation.id).join("; ");
  window.getCitationCallback = getCitationCallback;
  Object.defineProperty(globalThis, "getCitationCallback", {
    configurable: true,
    writable: true,
    value: getCitationCallback,
  });
}

export {};
