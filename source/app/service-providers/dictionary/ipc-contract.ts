/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Dictionary Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the dictionary provider, owned here
 *                  beside its handlers (the module file carries pre-existing
 *                  lint debt, so the contract lives adjacent).
 *
 * END HEADER
 */

/**
 * The term commands carry their terms at the message's top level, not in
 * payload. The handler validates the payload at runtime as well, but its
 * renderer-facing contract is a string array; keeping that shape here makes a
 * wrong IPC payload a compile-time error instead of deferring the mistake to
 * the main process.
 */
export type DictionaryProviderIPCContract = {
  'check': {
    request: { terms: string[] }
    response: boolean[]
  }
  'suggest': {
    request: { terms: string[] }
    response: string[][]
  }
  'add': {
    request: { terms: string[] }
    response: boolean[]
  }
  'get-user-dictionary': {
    request: { payload?: undefined }
    response: string[]
  }
  'set-user-dictionary': {
    request: { payload: string[] }
    response: undefined
  }
  'open-dictionary-folder': {
    request: { payload?: undefined }
    response: undefined
  }
}
