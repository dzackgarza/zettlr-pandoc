/**
 * A real preload-bridge stub for the visual capture entry, serving the
 * fixture session. No imports of its own — the entry imports this FIRST, so
 * window.ipc exists before the Pinia stores it mounts (which read
 * window.ipc at their own module-evaluation top level) are ever imported.
 * Mirrors document-collaboration-ipc-double.ts's header note for the same
 * reason.
 */

type InvokeMessage = { command: string, payload?: unknown }

let sceneSession: unknown

window.ipc = {
  invoke: async (_channel: string, message: InvokeMessage) => {
    switch (message.command) {
      case 'get-collaboration-session':
        return sceneSession
      case 'get-file-modification-status':
        return []
      default:
        return undefined
    }
  },
  on: () => () => {},
  send: () => {},
  sendSync: () => undefined,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

export function setAnnotationsSceneSession (session: unknown): void {
  sceneSession = session
}
