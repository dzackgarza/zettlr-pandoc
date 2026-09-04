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

interface InvokeMessage {
  command: string
  payload?: unknown
}

const listenersByChannel = new Map<string, IpcListener[]>()
const invokeCallCountByCommand = new Map<string, number>()

let invokeResponder: (message: InvokeMessage) => Promise<unknown> = async () => undefined

export const documentCollaborationIpcDouble = {
  /** Simulate a main-process broadcast reaching every renderer listener. */
  emit (channel: string, payload: unknown): void {
    for (const listener of listenersByChannel.get(channel) ?? []) {
      listener(undefined, payload)
    }
  },
  /** How many times `invoke` was called for one documents-provider command. */
  invokeCallCount (command: string): number {
    return invokeCallCountByCommand.get(command) ?? 0
  },
  /** Install what `invoke('documents-provider', { command, payload })` resolves to. */
  setInvokeResponder (responder: (message: InvokeMessage) => Promise<unknown>): void {
    invokeResponder = responder
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
    if (channel === 'documents-provider') {
      invokeCallCountByCommand.set(message.command, (invokeCallCountByCommand.get(message.command) ?? 0) + 1)
      return await invokeResponder(message)
    }
    return undefined
  },
  send: () => {},
  sendSync: () => undefined
}

// jsdom's `window` (installed by test/setup.js) is not the ambient
// lib.dom Window TypeScript resolves globalThis against in a Node/mocha
// context, so the property write below needs the same globalThis-as-any
// step provision-renderer-window-seams.ts uses for the identical reason.
// The transport object itself stays fully typed above.
;(globalThis as any).window.ipc = ipcTransport

export {}
