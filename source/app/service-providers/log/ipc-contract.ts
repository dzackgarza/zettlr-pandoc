/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Log Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the log provider, owned here beside its
 *                  handlers (the module file carries pre-existing lint debt,
 *                  so the contract lives adjacent).
 *
 * END HEADER
 */

import type { LogMessage } from './index'

/** nextIndex lives at the message's top level. */
export type LogProviderIPCContract = {
  'retrieve-log-chunk': {
    request: { nextIndex: number }
    response: LogMessage[]
  }
}
