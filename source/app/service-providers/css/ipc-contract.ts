/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    CSS Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the CSS provider, owned here beside its
 *                  handlers (the module file carries pre-existing lint debt,
 *                  so the contract lives adjacent).
 *
 * END HEADER
 */

/** 'set-custom-css' carries its css at the message's top level. */
export type CSSProviderIPCContract = {
  'get-custom-css-path': {
    request: { payload?: undefined }
    response: string
  }
  'get-custom-css': {
    request: { payload?: undefined }
    response: string
  }
  'set-custom-css': {
    request: { css: string }
    response: boolean
  }
}
