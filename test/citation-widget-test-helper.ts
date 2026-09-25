/**
 * Test bridge for the live citation widget's asynchronous citeproc contract.
 *
 * Legacy renderer specs already provide deterministic behavior through
 * window.getCitationCallback. Production no longer calls that callback from
 * CodeMirror; this adapter makes the async invoke path delegate to the same
 * per-spec callback without reintroducing synchronous IPC.
 */

export function installCitationIpcFromCallback (): () => void {
  const originalIpc = window.ipc
  const replacement = {
    on: originalIpc?.on ?? (() => () => undefined),
    send: originalIpc?.send ?? (() => undefined),
    sendSync: originalIpc?.sendSync ?? (() => undefined),
    invoke: async (channel: string, message?: {
      command?: string
      payload?: {
        database?: import('source/types/common/citeproc').CitationDatabase
        citations?: CiteItem[]
        composite?: boolean
      }
    }): Promise<unknown> => {
      if (channel === 'citeproc-provider' && message?.command === 'get-citation') {
        const payload = message.payload
        if (payload?.database === undefined) {
          throw new Error('citation test IPC bridge received get-citation without a database')
        }
        return window.getCitationCallback(payload.database)(
          payload.citations ?? [],
          payload.composite ?? false
        )
      }
      if (originalIpc === undefined) {
        return undefined
      }
      // This test bridge only intercepts citeproc. Other calls retain whatever
      // seam the importing spec installed.
      return await (originalIpc.invoke as (channel: string, message?: unknown) => Promise<unknown>)(channel, message)
    }
  }

  Object.defineProperty(window, 'ipc', {
    configurable: true,
    writable: true,
    value: replacement
  })

  return () => {
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      writable: true,
      value: originalIpc
    })
  }
}

export async function settleCitationWidgets (root: ParentNode = document): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.resolve()
    if (root.querySelector('.citeproc-pending') === null) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Citation widgets did not settle')
}
