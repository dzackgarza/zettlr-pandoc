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

const w = globalThis as any;

if (w.window !== undefined && w.window.ipc === undefined) {
  w.window.ipc = {
    on: () => () => {},
    invoke: async () => undefined,
    send: () => {},
    sendSync: () => undefined,
  };
  w.ipc = w.window.ipc;
}

if (w.window !== undefined && typeof w.window.getCitationCallback !== "function") {
  w.window.getCitationCallback = () => (citations: Array<{ id: string }>) =>
    citations.map((citation) => citation.id).join("; ");
  w.getCitationCallback = w.window.getCitationCallback;
}

export {};
