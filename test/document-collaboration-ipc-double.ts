/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A real preload-bridge double for the collaboration store
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * Description:     source/pinia/document-collaboration-store.ts reads
 *                  window.ipc at module-evaluation time, so window.ipc must
 *                  already be a working transport before that module is
 *                  first imported anywhere in this process. This module has
 *                  no imports of its own, so importing it FIRST (before the
 *                  store) installs window.ipc synchronously, ahead of the
 *                  store's own top-level read of it.
 *
 *                  It is not a mock of the IPC contract: `on` really queues
 *                  listeners per channel, `emit` really invokes them, and
 *                  `invoke` really counts calls and awaits a caller-supplied
 *                  responder. It is the renderer side of the same seam
 *                  collaboration-test-authority.ts is the main-process side
 *                  of: the smallest complete implementation of the preload
 *                  bridge, not a behavior stand-in for it.
 *
 * END HEADER
 */

type IpcListener = (event: unknown, payload: unknown) => void

/**
 * The renderer sends collaboration work over two shapes of channel: the
 * `documents-provider` multiplexer, where the operation is a `command`
 * field (only the session read, get-collaboration-session, still goes over
 * it), and a typed operation channel per operation, where the channel name
 * IS the operation and the whole message is the payload (every annotation
 * and review mutation — see DocumentIpcHandlers). Both reach the responder
 * here, and both are counted under the operation's own name.
 */
interface InvokeMessage {
  command: string
  payload?: unknown
}

const listenersByChannel = new Map<string, IpcListener[]>()
const invokeCallCountByCommand = new Map<string, number>()

let invokeResponder: (message: InvokeMessage) => Promise<unknown> = async () => undefined
// Real synchronous readers (useConfigStore's retrieveConfig, resolved via
// window.ipc.sendSync at store construction) run at construction time of
// any component tree that transitively depends on the config store — not
// only documents-provider ones. Defaulting to undefined is correct for a
// suite that never mounts such a tree; a suite that does (e.g. mounting
// MainSidebar.vue to prove the annotations tab's rendered badge) installs
// its own responder instead of adding config-specific knowledge here.
let sendSyncResponder: (channel: string, message: InvokeMessage | undefined) => unknown = () => undefined

export const documentCollaborationIpcDouble = {
  /** Simulate a main-process broadcast reaching every renderer listener. */
  emit (channel: string, payload: unknown): void {
    for (const listener of listenersByChannel.get(channel) ?? []) {
      listener(undefined, payload)
    }
  },
  /** How many times `invoke` named one operation, by command or channel. */
  invokeCallCount (command: string): number {
    return invokeCallCountByCommand.get(command) ?? 0
  },
  /** Install what an `invoke` resolves to. */
  setInvokeResponder (responder: (message: InvokeMessage) => Promise<unknown>): void {
    invokeResponder = responder
  },
  /** Install what `sendSync(channel, { command, payload })` returns. */
  setSendSyncResponder (responder: (channel: string, message: InvokeMessage | undefined) => unknown): void {
    sendSyncResponder = responder
  },
  /**
   * Drop every registered listener and call count. Each test creates its own
   * Pinia store, which registers its own 'documents-update' listener onto
   * this module-level double; without a reset between tests, an earlier
   * test's store would still be listening (and being counted) during a
   * later one.
   */
  reset (): void {
    listenersByChannel.clear()
    invokeCallCountByCommand.clear()
    invokeResponder = async () => undefined
    sendSyncResponder = () => undefined
  }
}

const ipcTransport = {
  on (channel: string, listener: IpcListener): () => void {
    const list = listenersByChannel.get(channel) ?? []
    list.push(listener)
    listenersByChannel.set(channel, list)
    return () => {
      const idx = list.indexOf(listener)
      if (idx >= 0) {
        list.splice(idx, 1)
      }
    }
  },
  invoke: async (channel: string, message: InvokeMessage): Promise<unknown> => {
    const operation = channel === 'documents-provider' ? message.command : channel
    const request = channel === 'documents-provider'
      ? message
      : { command: channel, payload: message }
    invokeCallCountByCommand.set(operation, (invokeCallCountByCommand.get(operation) ?? 0) + 1)
    return await invokeResponder(request)
  },
  send: () => {},
  sendSync: (channel: string, message?: InvokeMessage) => sendSyncResponder(channel, message)
}

// jsdom's `window` (installed by test/setup.js) is not the ambient
// lib.dom Window TypeScript resolves globalThis against in a Node/mocha
// context, so the property write below needs the same globalThis-as-any
// step provision-renderer-window-seams.ts uses for the identical reason.
// The transport object itself stays fully typed above.
;(globalThis as any).window.ipc = ipcTransport

export {}
