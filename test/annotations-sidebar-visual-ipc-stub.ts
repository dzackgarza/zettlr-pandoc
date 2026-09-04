/**
 * A real preload-bridge stub for the visual capture entry, serving the
 * fixture session. No imports of its own — the entry imports this FIRST, so
 * window.ipc exists before the Pinia stores it mounts (which read
 * window.ipc at their own module-evaluation top level) are ever imported.
 * Mirrors document-collaboration-ipc-double.ts's header note for the same
 * reason.
 */

type InvokeMessage = { command: string, payload?: unknown }

/** One request the panel raised, as it reached the preload bridge. */
export interface RecordedRequest {
  channel: string
  message: unknown
}

let sceneSession: unknown
const recorded: RecordedRequest[] = []

window.ipc = {
  invoke: async (channel: string, message: InvokeMessage) => {
    recorded.push({ channel, message })
    switch (message.command) {
      case 'get-collaboration-session':
        return sceneSession
      case 'get-file-modification-status':
        return []
      default:
        // The typed operation channels (the review mutations) answer with
        // the provider's success shape, so the panel's own busy state
        // settles the way it does in the app.
        return channel.startsWith('documents:') ? { ok: true } : undefined
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

/** Every request the mounted panel raised, in order. */
export function recordedRequests (): RecordedRequest[] {
  return recorded
}
